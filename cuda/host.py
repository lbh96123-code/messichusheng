"""Length framed JSON + raw tensors over inherited pipes; stdout is protocol only."""
import base64
import json
import os
import struct
import sys
import traceback
import time

stream = sys.stdout.buffer
sys.stdout = sys.stderr
import numpy as np
import onnxruntime as ort

# Only load NVIDIA libraries from this isolated runtime, never a system CUDA install.
ort.preload_dlls(directory="")
session = None
types = {"int32": np.int32, "float32": np.float32, "int64": np.int64}


def read_exact(n):
    data = bytearray()
    while len(data) < n:
        part = sys.stdin.buffer.read(n - len(data))
        if not part:
            raise EOFError()
        data.extend(part)
    return data


while True:
    try:
        length = struct.unpack("<I", read_exact(4))[0]
        if length > 32 * 1024 * 1024:
            raise ValueError("Frame too large")
        received_ns = time.perf_counter_ns()
        received_at = time.time()
        raw = read_exact(length)
        payload_ns = time.perf_counter_ns()
        m = json.loads(raw)
        parsed_ns = time.perf_counter_ns()
    except EOFError:
        break
    try:
        if m["op"] == "init":
            if "CUDAExecutionProvider" not in ort.get_available_providers():
                raise RuntimeError("CUDA provider unavailable")
            opts = ort.SessionOptions()
            opts.add_free_dimension_override_by_name("B", m["batch"])
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            opts.log_severity_level = 3
            # TF32 off: compare like precision with the existing FP32 model.
            session = ort.InferenceSession(m["model"], opts, providers=[("CUDAExecutionProvider", {"device_id": 0, "use_tf32": 0})])
            if session.get_providers()[0] != "CUDAExecutionProvider":
                raise RuntimeError("CUDA initialization failed; CPU fallback rejected")
            session.disable_fallback()
            result = {"inputs": [x.name for x in session.get_inputs()]}
        elif m["op"] == "run":
            decode_ns = time.perf_counter_ns()
            feeds = {k: np.frombuffer(base64.b64decode(v["data"]), dtype=types[v["type"]]).reshape(v["dims"]) for k, v in m["feeds"].items()}
            names = [o.name for o in session.get_outputs()]
            infer_ns = time.perf_counter_ns()
            values = session.run(names, feeds)
            result_ns = time.perf_counter_ns()
            result = {k: {"type": str(v.dtype), "dims": list(v.shape), "data": base64.b64encode(v.tobytes()).decode("ascii")} for k, v in zip(names, values)}
            encoded_ns = time.perf_counter_ns()
        elif m["op"] == "close":
            session = None
            break
        else:
            raise ValueError("Unknown operation")
        response = {"id": m["id"], "result": result}
        if m.get("detailedTiming") and m["op"] == "run":
            response["timing"] = {"schema": 1, "pid": os.getpid(), "receivedAt": received_at,
                "payloadReadMs": (payload_ns-received_ns)/1e6, "requestJsonMs": (parsed_ns-payload_ns)/1e6,
                "handlerOtherMs": (decode_ns-parsed_ns)/1e6,
                "inputDecodeMs": (infer_ns-decode_ns)/1e6, "runtimeMs": (result_ns-infer_ns)/1e6,
                "outputEncodeMs": (encoded_ns-result_ns)/1e6, "handleMs": (encoded_ns-received_ns)/1e6}
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        response = {"id": m["id"], "error": str(e)}
    payload = json.dumps(response, separators=(",", ":")).encode()
    stream.write(struct.pack("<I", len(payload)))
    stream.write(payload)
    stream.flush()
