"""Exercise the real Python framing/timing code with a stub runtime, no GPU needed."""
import json, pathlib, struct, subprocess, sys

host = pathlib.Path(__file__).resolve().parents[1] / 'cuda' / 'host.py'
launcher = r'''
import sys,types,runpy,time
np=types.ModuleType('numpy');np.int32='int32';np.float32='float32';np.int64='int64';sys.modules['numpy']=np
ort=types.ModuleType('onnxruntime');ort.preload_dlls=lambda **kw:None;ort.get_available_providers=lambda:['CUDAExecutionProvider'];ort.GraphOptimizationLevel=types.SimpleNamespace(ORT_ENABLE_ALL=99)
class Options:
 def add_free_dimension_override_by_name(self,*a):pass
class Session:
 def __init__(self,*a,**kw):assert kw['providers'][0][1]['use_tf32']==0
 def get_providers(self):return ['CUDAExecutionProvider']
 def disable_fallback(self):pass
 def get_inputs(self):return []
 def get_outputs(self):return []
 def run(self,*a):time.sleep(.002);return []
ort.SessionOptions=Options;ort.InferenceSession=Session;sys.modules['onnxruntime']=ort
runpy.run_path(sys.argv[1],run_name='__main__')
'''
requests=[{'op':'init','id':1,'model':'fake','batch':32},{'op':'run','id':2,'feeds':{},'detailedTiming':True},{'op':'run','id':3,'feeds':{}}]
payload=b''.join(struct.pack('<I',len(raw))+raw for raw in (json.dumps(r).encode() for r in requests))
p=subprocess.run([sys.executable,'-c',launcher,str(host)],input=payload,capture_output=True,timeout=10,check=True)
data=p.stdout;rows=[]
while data:
 n=struct.unpack('<I',data[:4])[0];rows.append(json.loads(data[4:4+n]));data=data[4+n:]
assert [r['id'] for r in rows]==[1,2,3]
t=rows[1]['timing'];assert t['runtimeMs']>=1
parts=['payloadReadMs','requestJsonMs','handlerOtherMs','inputDecodeMs','runtimeMs','outputEncodeMs']
assert all(t[k]>=0 for k in parts)
assert abs(sum(t[k] for k in parts)-t['handleMs'])<0.001
assert 'timing' not in rows[0] and 'timing' not in rows[2]
print('通过：真实 Python 协议、运行库分段口径、分段相加一致、关闭计时和 FP32 配置；GPU 使用桩。')
