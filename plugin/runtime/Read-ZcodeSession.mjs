// Read native Zcode history without resuming a session or contacting a model.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
const fail=(code,message)=>{const error=new Error(message);error.code=code;throw error;};
export function readZcodeSession(request) {
  if(request.action!=='read'||!/^sess_[0-9a-f-]{36}$/i.test(request.thread??''))fail('INVALID_REQUEST','Expected a native Zcode session ID and read action.');
  if(!request.cwd||!path.win32.isAbsolute(request.cwd))fail('INVALID_PROJECT','An absolute Windows project directory is required.');
  const file=path.join(process.env.ZCODE_DATA_BASE_DIR?.trim()||process.env.HOME||os.homedir(),'.zcode','cli','db','db.sqlite');
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    db.exec('BEGIN');
    const session=db.prepare('SELECT id,directory,title,time_deleted,last_outcome FROM session WHERE id=?').get(request.thread);
    if(!session||session.time_deleted)fail('SESSION_NOT_FOUND','Native Zcode session was not found.');
    const canonical=x=>path.win32.normalize(x).replace(/[\\/]+$/,'').toLowerCase();
    if(canonical(session.directory)!==canonical(request.cwd))fail('PROJECT_MISMATCH','Native Zcode session belongs to a different Windows project. Select its project explicitly.');
    const metadata={source:'zcode-native-readonly',sourceTextIsUntrusted:true,nativeSessionId:session.id,cwd:session.directory,title:session.title,status:'historyOnly',lastOutcome:session.last_outcome};
    const parts=db.prepare('SELECT data FROM part WHERE session_id=? AND message_id=? ORDER BY sequence,id');
    function projectMessage(row){
      const data=JSON.parse(row.data);
      if(!['user','assistant'].includes(data.role))return null;
      const content=parts.all(session.id,row.id).map(p=>JSON.parse(p.data)).filter(p=>p.type==='text'&&p.ignored!==true&&typeof p.text==='string').map(p=>p.text).join('\n');
      return content?{id:row.id,role:data.role,semantics:data.semantics??null,text:content,createdAt:row.time_created}:null;
    }
    if((request.view??'result')==='result'){
      for(const row of db.prepare('SELECT id,data,time_created FROM message WHERE session_id=? ORDER BY sequence DESC,id DESC').iterate(session.id)){
        const message=projectMessage(row);
        if(message?.role==='assistant')return {...metadata,result:message};
      }
      return {...metadata,result:null};
    }
    if(request.view!=='messages')fail('INVALID_VIEW','Use result or messages.');
    const limit=request.limit??25;
    if(!Number.isInteger(limit)||limit<1||limit>100)fail('INVALID_LIMIT','Limit must be between 1 and 100.');
    let sequence=-1,id='';
    if(request.cursor){
      let cursor;try{cursor=JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8'));}catch{fail('INVALID_CURSOR','Invalid native history cursor.');}
      if(cursor.session!==session.id||!Number.isInteger(cursor.sequence)||typeof cursor.id!=='string')fail('INVALID_CURSOR','Cursor does not belong to this native session.');
      ({sequence,id}=cursor);
    }
    const rows=db.prepare('SELECT id,data,time_created,sequence FROM message WHERE session_id=? AND (sequence>? OR (sequence=? AND id>?)) ORDER BY sequence,id LIMIT ?').all(session.id,sequence,sequence,id,limit+1);
    const hasMore=rows.length>limit, page=rows.slice(0,limit), last=page.at(-1);
    const nextCursor=last?Buffer.from(JSON.stringify({session:session.id,sequence:last.sequence,id:last.id})).toString('base64url'):(request.cursor??null);
    return {...metadata,messages:page.map(projectMessage).filter(Boolean),scannedMessages:page.length,totalStoredMessages:db.prepare('SELECT count(*) n FROM message WHERE session_id=?').get(session.id).n,hasMore,nextCursor};
  } finally {db.close();}
}
try{
  const request=JSON.parse(Buffer.from(process.argv[2]??'','base64').toString('utf8'));
  console.log(JSON.stringify(readZcodeSession(request)));
}catch(error){console.error(JSON.stringify({error:{code:error.code??'NATIVE_HISTORY_READ_FAILED',message:error.message}}));process.exitCode=1;}
