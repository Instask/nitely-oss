import { mkdtemp,mkdir,writeFile,readFile,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { PythonSkillRuntime } from '../src/skills/runtime.js';
const image=process.env.NITELY_OCI_IMAGE;
if(!image)throw new Error('Set NITELY_OCI_IMAGE to a local image containing Python 3 and configure a rootless engine.');
const repo=await mkdtemp(join(tmpdir(),'nitely-real-skill-'));
const pkg=join(repo,'.nitely/skills/example');
await mkdir(pkg,{recursive:true});
await writeFile(join(pkg,'SKILL.md'),'---\nname: example\ndescription: real Python Skill\n---\nExecute main.py.');
const runtime=new PythonSkillRuntime({ image, env:process.env });
const sentinel=join(tmpdir(),'nitely-host-sentinel-'+process.pid);await writeFile(sentinel,'private-host-data');
const initial=(await readdir(tmpdir())).filter(x=>x.startsWith('nitely-skill-'));
try {
 const cases=[
  {name:'success',code:"import os\nassert os.getuid()!=0\nassert open('/workspace/inputs/value.txt').read()=='declared'\nopen(os.environ['NITELY_OUTPUT_DIR']+'/result.txt','w').write('artifact')\nprint('success')",outputs:['result.txt'],failure:undefined},
  {name:'host-and-network-denied',code:`import os,socket\nassert not os.path.exists(${JSON.stringify(sentinel)})\nassert not os.path.exists('/var/run/docker.sock')\ntry:\n socket.create_connection(('1.1.1.1',443),timeout=1)\n raise AssertionError('network allowed')\nexcept OSError: pass\nprint('denied')`,failure:undefined},
  {name:'timeout',code:'import time\ntime.sleep(30)',timeoutMs:500,failure:'timeout'},
  {name:'output-limit',code:"print('x'*1100000)",failure:'output-limit'},
  {name:'unsafe-artifact',code:"import os\nos.symlink('/etc/passwd',os.environ['NITELY_OUTPUT_DIR']+'/result.txt')",outputs:['result.txt'],failure:'artifact'},
  {name:'restrictive-permissions',code:"import os\nos.mkdir(os.environ['NITELY_OUTPUT_DIR']+'/private',0o700)\nopen(os.environ['NITELY_OUTPUT_DIR']+'/private/x','w').write('tmpfs only')",failure:undefined},
  {name:'memory-bound',code:"x=bytearray(600*1024*1024)",failure:'process-exit'},
 ];
 for(const c of cases){
  await writeFile(join(pkg,'main.py'),c.code);
  const r=await runtime.execute(repo,{skillId:'example',entrypoint:'main.py',inputs:{'value.txt':'declared'},outputs:c.outputs??[],timeoutMs:c.timeoutMs??5000});
  console.log(JSON.stringify({name:c.name,executionId:r.executionId,failure:r.failure,exitCode:r.exitCode,durationMs:r.durationMs}));assert.equal(r.failure,c.failure);
  if(c.outputs?.length && !c.failure)assert.equal(await readFile(join(repo,r.artifacts[0].path),'utf8'),'artifact');
  assert.deepEqual((await readdir(tmpdir())).filter(x=>x.startsWith('nitely-skill-')).sort(),initial.sort());
 }
} finally { await rm(repo,{recursive:true,force:true});await rm(sentinel,{force:true}); }
