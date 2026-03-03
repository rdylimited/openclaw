import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

const STANDARD_HOURS = 8;

function calcHoursWorked(clockIn: string, clockOut: string): number {
  const inMs = new Date(clockIn).getTime();
  const outMs = new Date(clockOut).getTime();
  if (isNaN(inMs) || isNaN(outMs) || outMs <= inMs) return 0;
  return (outMs - inMs) / (1000 * 60 * 60);
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createAttendanceLogTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "hr_attendance_log",
    label: "HR: Attendance Log",
    description:
      "Clock employees in/out, retrieve attendance records, and generate monthly summaries with hours and overtime.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("clock_in"),
          Type.Literal("clock_out"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("summary"),
        ],
        { description: "Operation to perform" },
      ),
      employee_id: Type.Optional(Type.String({ description: "Employee UUID" })),
      date: Type.Optional(
        Type.String({
          description: "Date (YYYY-MM-DD), defaults to today for clock_in/clock_out/get",
        }),
      ),
      notes: Type.Optional(Type.String({ description: "Optional notes for clock_in" })),
      date_from: Type.Optional(
        Type.String({ description: "Start date filter for list (YYYY-MM-DD)" }),
      ),
      date_to: Type.Optional(Type.String({ description: "End date filter for list (YYYY-MM-DD)" })),
      month: Type.Optional(
        Type.Number({ minimum: 1, maximum: 12, description: "Month for summary (1-12)" }),
      ),
      year: Type.Optional(Type.Number({ description: "Year for summary (e.g. 2025)" })),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string;

      try {
        switch (action) {
          case "clock_in": {
            const employee_id = params.employee_id as string | undefined;
            if (!employee_id) return errorResult("employee_id is required for clock_in");

            const date = (params.date as string | undefined) ?? todayDate();
            const clock_in = new Date().toISOString();

            // Upsert attendance record (one record per employee per day)
            const payload = {
              tenant_id: db.tenantId,
              employee_id,
              date,
              clock_in,
              notes: (params.notes as string | undefined) ?? null,
              hours_worked: null,
              overtime_hours: null,
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("attendance")
              .upsert(
                { ...payload, created_at: new Date().toISOString() },
                { onConflict: "tenant_id,employee_id,date", ignoreDuplicates: false },
              )
              .select("*")
              .single();

            if (error) return errorResult(`Failed to clock in: ${error.message}`);

            return jsonResult(data, `Employee ${employee_id} clocked in at ${clock_in} on ${date}`);
          }

          case "clock_out": {
            const employee_id = params.employee_id as string | undefined;
            if (!employee_id) return errorResult("employee_id is required for clock_out");

            const date = (params.date as string | undefined) ?? todayDate();
            const clock_out = new Date().toISOString();

            // Fetch existing record to get clock_in time
            const { data: existing, error: fetchError } = await db.client
              .from("attendance")
              .select("clock_in")
              .eq("tenant_id", db.tenantId)
              .eq("employee_id", employee_id)
              .eq("date", date)
              .single();

            if (fetchError || !existing) {
              return errorResult(`No clock-in record found for employee ${employee_id} on ${date}`);
            }

            if (!existing.clock_in) {
              return errorResult(`Employee ${employee_id} has not clocked in on ${date}`);
            }

            const hoursWorked = calcHoursWorked(existing.clock_in, clock_out);
            const overtimeHours = Math.max(0, hoursWorked - STANDARD_HOURS);

            const updates = {
              clock_out,
              hours_worked: parseFloat(hoursWorked.toFixed(2)),
              overtime_hours: parseFloat(overtimeHours.toFixed(2)),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("attendance")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("employee_id", employee_id)
              .eq("date", date)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to clock out: ${error.message}`);

            return jsonResult(
              data,
              `Employee ${employee_id} clocked out. Hours worked: ${hoursWorked.toFixed(2)}h (overtime: ${overtimeHours.toFixed(2)}h)`,
            );
          }

          case "get": {
            const employee_id = params.employee_id as string | undefined;
            const date = (params.date as string | undefined) ?? todayDate();

            if (!employee_id) return errorResult("employee_id is required for get");

            const { data, error } = await db.client
              .from("attendance")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("employee_id", employee_id)
              .eq("date", date)
              .single();

            if (error) return errorResult(`Attendance record not found: ${error.message}`);

            return jsonResult(data, `Attendance for employee ${employee_id} on ${date}`);
          }

          case "list": {
            const employee_id = params.employee_id as string | undefined;
            if (!employee_id) return errorResult("employee_id is required for list");

            const date_from = params.date_from as string | undefined;
            const date_to = params.date_to as string | undefined;

            let query = db.client
              .from("attendance")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("employee_id", employee_id)
              .order("date", { ascending: false });

            if (date_from) query = query.gte("date", date_from);
            if (date_to) query = query.lte("date", date_to);

            const { data, error } = await query;

            if (error) return errorResult(`Failed to list attendance: ${error.message}`);

            return jsonResult(
              { attendance: data ?? [], employee_id },
              `Found ${(data ?? []).length} attendance records for employee ${employee_id}`,
            );
          }

          case "summary": {
            const employee_id = params.employee_id as string | undefined;
            if (!employee_id) return errorResult("employee_id is required for summary");

            const now = new Date();
            const month = (params.month as number | undefined) ?? now.getMonth() + 1;
            const year = (params.year as number | undefined) ?? now.getFullYear();

            const monthStr = String(month).padStart(2, "0");
            const dateFrom = `${year}-${monthStr}-01`;
            // Last day of month: go to first day of next month and back one day
            const lastDay = new Date(year, month, 0).getDate();
            const dateTo = `${year}-${monthStr}-${String(lastDay).padStart(2, "0")}`;

            const { data, error } = await db.client
              .from("attendance")
              .select("date, hours_worked, overtime_hours, clock_in, clock_out")
              .eq("tenant_id", db.tenantId)
              .eq("employee_id", employee_id)
              .gte("date", dateFrom)
              .lte("date", dateTo)
              .order("date", { ascending: true });

            if (error)
              return errorResult(`Failed to fetch attendance for summary: ${error.message}`);

            const records = data ?? [];
            const daysWorked = records.filter((r) => r.clock_in !== null).length;
            const totalHours = records.reduce((sum, r) => sum + (r.hours_worked ?? 0), 0);
            const totalOvertime = records.reduce((sum, r) => sum + (r.overtime_hours ?? 0), 0);

            return jsonResult(
              {
                employee_id,
                month,
                year,
                days_worked: daysWorked,
                total_hours: parseFloat(totalHours.toFixed(2)),
                total_overtime_hours: parseFloat(totalOvertime.toFixed(2)),
                records,
              },
              `Summary for employee ${employee_id} (${year}-${monthStr}): ${daysWorked} days, ${totalHours.toFixed(2)}h total, ${totalOvertime.toFixed(2)}h overtime`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: clock_in, clock_out, get, list, summary`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
