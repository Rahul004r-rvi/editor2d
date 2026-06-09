"""FastAPI service: floor plan JSON from decoded slice geometry or GLB."""

from __future__ import annotations

import os
import traceback
from typing import Any

from fastapi import FastAPI, File, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from floor_analyzer import analyze_glb_bytes, analyze_triangles

app = FastAPI(title="NavMe Floor Analyzer", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SliceAnalyzeBody(BaseModel):
    triangles: list[float] = Field(default_factory=list)
    sliceY: float = -1.6
    cellSize: float = 0.1


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/analyze-slice")
def analyze_slice(body: SliceAnalyzeBody) -> JSONResponse:
    try:
        plan = analyze_triangles(
            body.triangles,
            slice_y=body.sliceY,
            cell_size=body.cellSize,
        )
        return JSONResponse(plan)
    except Exception as exc:
        traceback.print_exc()
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    slice_y: float = Query(-1.6, alias="sliceY"),
    cell_size: float = Query(0.1, alias="cellSize"),
) -> JSONResponse:
    data = await file.read()
    if not data:
        return JSONResponse({"error": "Empty file"}, status_code=400)
    try:
        plan = analyze_glb_bytes(data, slice_y=slice_y, cell_size=cell_size)
        return JSONResponse(plan)
    except Exception as exc:
        traceback.print_exc()
        return JSONResponse({"error": str(exc)}, status_code=500)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("FLOOR_ANALYZER_PORT", "8787"))
    uvicorn.run("server:app", host="127.0.0.1", port=port, reload=False)
