#!/usr/bin/env python3
"""
Patch: vLLM streaming tool call fix

vLLM's qwen3_xml parser fails in streaming mode, outputting <tool_call> XML
as text instead of structured tool_calls. This interceptor detects XML tool
calls in text blocks post-stream and converts them to proper toolCall blocks.

Run after pnpm install to patch node_modules.
"""
import pathlib
import sys

TARGET = "node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js"
MARKER = "vllm-stream-fix"

f = pathlib.Path(TARGET)
if not f.exists():
    print(f"[patch] Target not found: {TARGET}")
    sys.exit(0)

content = f.read_text()

if MARKER in content:
    print("[patch] vLLM streaming fix already applied")
    sys.exit(0)

# Also remove any leftover TOOL-DEBUG lines
content = content.replace(
    'if (context.tools) { console.error("[TOOL-DEBUG] context.tools count=" + (context.tools?.length ?? 0) + " names=" + (context.tools?.map(t=>t.name).join(",") ?? "none")); console.error("[TOOL-DEBUG] context.tools count=" + (context.tools?.length ?? 0) + " names=" + (context.tools?.map(t=>t.name).join(",") ?? "none"));\n        params.tools = convertTools(context.tools, compat);',
    'if (context.tools) {\n        params.tools = convertTools(context.tools, compat);'
)

INTERCEPTOR = r'''
            // [LOCAL PATCH] vLLM streaming tool call fix: qwen3_xml parser fails in
            // streaming mode, outputting <tool_call> XML as text instead of structured
            // tool_calls. Detect and convert them post-stream.
            const toolCallXmlRegex = /<tool_call>\s*<function=([^>]+)>\s*([\s\S]*?)<\/function>\s*<\/tool_call>/g;
            const newContent = [];
            let toolCallCounter = 0;
            for (const block of output.content) {
                if (block.type === "text" && toolCallXmlRegex.test(block.text)) {
                    toolCallXmlRegex.lastIndex = 0;
                    let match;
                    let lastIndex = 0;
                    while ((match = toolCallXmlRegex.exec(block.text)) !== null) {
                        const beforeText = block.text.slice(lastIndex, match.index).trim();
                        if (beforeText) {
                            newContent.push({ type: "text", text: beforeText });
                        }
                        const fnName = match[1].trim();
                        const paramsBlock = match[2].trim();
                        const args = {};
                        const paramRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
                        let pm;
                        while ((pm = paramRegex.exec(paramsBlock)) !== null) {
                            args[pm[1].trim()] = pm[2].trim();
                        }
                        toolCallCounter++;
                        const toolCallBlock = {
                            type: "toolCall",
                            id: `vllm-stream-fix-${Date.now()}-${toolCallCounter}`,
                            name: fnName,
                            arguments: args,
                        };
                        newContent.push(toolCallBlock);
                        stream.push({
                            type: "toolcall_start",
                            contentIndex: newContent.length - 1,
                            partial: output,
                        });
                        stream.push({
                            type: "toolcall_end",
                            contentIndex: newContent.length - 1,
                            toolCall: toolCallBlock,
                            partial: output,
                        });
                        lastIndex = match.index + match[0].length;
                    }
                    const afterText = block.text.slice(lastIndex).trim();
                    if (afterText) {
                        newContent.push({ type: "text", text: afterText });
                    }
                } else {
                    newContent.push(block);
                }
            }
            if (toolCallCounter > 0) {
                output.content = newContent;
                output.stopReason = "tool_calls";
            }
'''

target = '            finishCurrentBlock(currentBlock);\n            if (options?.signal?.aborted) {'
replacement = '            finishCurrentBlock(currentBlock);\n' + INTERCEPTOR + '\n            if (options?.signal?.aborted) {'

if target in content:
    content = content.replace(target, replacement, 1)
    f.write_text(content)
    print("[patch] vLLM streaming tool call fix applied successfully")
else:
    print("[patch] ERROR: injection point not found - SDK may have changed", file=sys.stderr)
    sys.exit(1)
