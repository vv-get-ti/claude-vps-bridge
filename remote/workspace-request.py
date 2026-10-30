"""One parser shared by native approval and execution; no shell evaluation."""
import argparse, json

def parse(argv):
    if argv in (['--help'],['-h']):return {'action':'info'}
    if len(argv)==1 and argv[0].lstrip().startswith('{'):
        request=json.loads(argv[0])
        if not isinstance(request,dict):raise ValueError('Expected an operation object')
        return request
    parser=argparse.ArgumentParser(prog='windows-workspace',exit_on_error=False)
    parser.add_argument('action',choices=['info','status','list','read','search','context','capability','jobs','job','artifact','media'])
    parser.add_argument('path',nargs='?');parser.add_argument('--pattern');parser.add_argument('--id')
    parser.add_argument('--offset',type=int);parser.add_argument('--limit',type=int)
    parser.add_argument('--request-id',dest='requestId');parser.add_argument('--wait-ms',dest='waitMs',type=int)
    parser.add_argument('--operation',choices=['status','cancel','output'])
    parser.add_argument('--stream',choices=['stdout','stderr']);parser.add_argument('--segment',type=int,choices=[0,1])
    parser.add_argument('--segment-id',dest='segmentId')
    parser.add_argument('--search-id',dest='searchId');parser.add_argument('--encoding',choices=['utf-8','base64'])
    args=vars(parser.parse_args(argv));return {k:v for k,v in args.items() if v is not None}
