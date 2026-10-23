# Optional Windows CUDA backend

Settings → 计算后端 → **CUDA / DirectML 对比测速**. Confirmation is required
before downloading. Components live in `userData/compute/<manifest id>`; the
application does not install drivers, edit PATH, or touch the existing DirectML
runtime. About 1.81 GB downloads; installation requires 7 GiB of free space for
archives and extracted files. Cancellation and failed installation remove staging.

`manifest.json` pins official python.org and PyPI Windows x64 archives, sizes and
SHA256 digests. Packages are unpacked privately, without system Python or pip.
CUDA 12.9 and cuDNN 9.14 were chosen to include Blackwell support. The NVIDIA
driver must already be installed; a successfully installed runtime still must
pass initialization, inference, and numerical comparison on the user's machine.

The distributed onnxruntime-node Windows binding provides DirectML, not CUDA.
`cuda_bridge.js` therefore uses the official Windows Python ORT GPU wheel in a
separate process. This also isolates the two ORT DLL versions. The optional bridge
adapts the existing session/Tensor API; CUDA errors at initialization restore the
original runtime. DirectML uses the original Node binding and original settings.

The comparison runs the same current FP32 model and deterministic varied inputs
on both backends, at batches 32 and 128, with one warmup and nine measured runs
per batch/backend. It tries the same four DML device indices as production and
chooses the fastest. Timings include transfers, serialization, and IPC. It reports
median/P90, speed ratio, top-choice agreement, and records maximum probability
deviation plus the model SHA256. A CUDA provider failing to load is an error,
never a successful CPU benchmark. Synthetic input timing does not measure a
complete 128/256/512 rollout or validate game recommendation quality.

Benchmark work is queued after production native calls drain. It is disabled
during active drafting. Outside the game a separate worker can run it; game
startup cancels that worker cooperatively before production GPU warmup. Selecting
a backend is persisted and takes effect on an explicit restart. Testing never
automatically changes the selection.

Validation: `npm run test:cuda` uses mocked GPUs/protocols and real archive/path
validation. Windows installation, DLL loading, and real NVIDIA timings need a
Windows x64 GPU acceptance run before release. Include 30/40/50-series cards and
both first installation and cached installation; compare selecting DirectML with
the previous release. No GPU performance claim is made by these tests.

Official references:

- https://onnxruntime.ai/docs/get-started/with-javascript/node.html
- https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html
- https://www.python.org/downloads/release/python-31210/
- https://docs.nvidia.com/cuda/blackwell-compatibility-guide/
