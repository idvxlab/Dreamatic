from __future__ import annotations

import json

from harness.tools.overflow import OverflowStore
from harness.types.tools import ToolParam, ToolSchema


READ_TOOL_OUTPUT_SCHEMA = ToolSchema(
    name="read_tool_output",
    description=(
        "Read a page from a tool output that was stored after exceeding the "
        "normal output limit. Use the ref_id from an 'Output exceeded' result, "
        "then continue with next_offset until done is true."
    ),
    params=[
        ToolParam(
            name="ref_id",
            type="string",
            description="Overflow reference id shown in the truncated tool result.",
        ),
        ToolParam(
            name="offset",
            type="integer",
            description="Character offset to start reading from, default 0.",
            required=False,
        ),
        ToolParam(
            name="limit",
            type="integer",
            description="Maximum characters to return, default 4000 and maximum 6000.",
            required=False,
        ),
    ],
)


def make_read_tool_output_tool(store: OverflowStore):
    async def read_tool_output_tool(
        ref_id: str,
        offset: int = 0,
        limit: int = 4000,
    ) -> str:
        content = await store.retrieve(ref_id)
        if content is None:
            return json.dumps(
                {
                    "ok": False,
                    "error": "Tool output reference was not found or has expired.",
                    "ref_id": ref_id,
                },
                ensure_ascii=False,
            )
        start = max(0, int(offset or 0))
        page_size = max(1, min(int(limit or 4000), 6000))
        end = min(len(content), start + page_size)
        return json.dumps(
            {
                "ok": True,
                "ref_id": ref_id,
                "offset": start,
                "next_offset": end,
                "done": end >= len(content),
                "total_characters": len(content),
                "content": content[start:end],
            },
            ensure_ascii=False,
        )

    return read_tool_output_tool
