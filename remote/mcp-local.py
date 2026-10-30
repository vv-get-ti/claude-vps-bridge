"""Claude stdio MCP -> authenticated existing duplex channel -> Windows MCP."""
import concurrent.futures,json,os,socket,sys,threading,uuid
connection_id=str(uuid.uuid4())
lock=threading.Lock()
def forward(frame=None,close=False):
    request={'action':'mcp','server':'playwright','connectionId':connection_id}
    if close:request['close']=True
    else:request['frame']=frame
    payload={'sessionId':os.environ['WINDOWS_BRIDGE_SESSION'],'token':os.environ['WINDOWS_TOOL_TOKEN'],'internal':True,'request':request}
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as sock:
        sock.settimeout(108);sock.connect(os.environ['WINDOWS_TOOL_SOCKET']);sock.sendall((json.dumps(payload)+'\n').encode())
        data=b''
        while b'\n' not in data:
            chunk=sock.recv(65536)
            if not chunk:raise RuntimeError('MCP channel disconnected; no operation was replayed')
            data+=chunk
            if len(data)>48*1024*1024:raise RuntimeError('MCP result exceeds 48 MiB')
    reply=json.loads(data.split(b'\n')[0])
    if not reply.get('ok'):raise RuntimeError(reply.get('error',{}).get('message','MCP channel error'))
    return reply['value']
def process(frame):
    try:reply=forward(frame)
    except Exception as e:reply={'jsonrpc':'2.0','id':frame.get('id'),'error':{'code':-32000,'message':str(e)}}
    if 'id' in frame:
        with lock:print(json.dumps(reply,ensure_ascii=False),flush=True)
if __name__=='__main__':
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for line in sys.stdin:
                frame=json.loads(line)
                if frame.get('method') in ('initialize','notifications/initialized'):process(frame)
                else:pool.submit(process,frame)
    finally:
        try:forward(close=True)
        except Exception:pass
