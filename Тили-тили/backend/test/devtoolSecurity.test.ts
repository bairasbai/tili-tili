import { beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import net from 'node:net'

async function fixture(...args: string[]): Promise<Record<string, unknown>> {
  return await fixtureExit(0,...args)
}
async function removeOwnedDirectory(directory:string){
  if(dirname(directory)!==resolve(tmpdir()))throw Error('Owned child directory escaped temporary parent')
  await rm(directory,{recursive:true,force:true})
  await expect(stat(directory)).rejects.toMatchObject({code:'ENOENT'})
}
async function fixtureExit(expectedExit:number,...args: string[]): Promise<Record<string, unknown>> {
  const directory=await mkdtemp(join(tmpdir(),`tili-devtool-owned-${process.pid}-`))
  const command=[fileURLToPath(new URL('./helpers/devtoolSecurityFixture.mjs',import.meta.url)),...args]
  const createdAt=new Date().toISOString()
  const child = spawn(process.execPath,command,{cwd:process.cwd(),env:{...process.env,DEVTOOL_FIXTURE_DIRECTORY:directory},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']})
  let port:number|null=null
  function record(state:string){
    const entry={owner:process.env.DEVTOOL_FIXTURE_OWNER??'devtool-security',pid:child.pid,startedAt:createdAt,command:[process.execPath,...command],cwd:process.cwd(),directory,port,state}
    process.stdout.write(`DEVTOOL_PARENT ${JSON.stringify(entry)}\n`)
    if(process.env.DEVTOOL_FIXTURE_EVIDENCE)appendFileSync(process.env.DEVTOOL_FIXTURE_EVIDENCE,JSON.stringify(entry)+'\n')
  }
  record('started')
  child.on('message',message=>{const state=message as {type?:string;port?:number};if(state.type==='owned-fixture-state'&&typeof state.port==='number')port=state.port})
  let stdout='',stderr='',expired=false
  child.stdout!.on('data',chunk=>{stdout+=String(chunk)})
  child.stderr!.on('data',chunk=>{stderr+=String(chunk)})
  const closed=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
  let hardStop:ReturnType<typeof setTimeout>|undefined
  const deadline=setTimeout(()=>{expired=true;record('requested-shutdown');if(child.connected)child.send('shutdown');else child.kill('SIGTERM');hardStop=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')},2000)},args[0]==='vite-server'?35000:14000)
  try {
    const code=await closed
    expect(expired,'Owned child deadline').toBe(false)
    expect(code,stderr+'\n'+stdout).toBe(expectedExit)
    const report=JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string,unknown>
    if(expectedExit===0)expect(report.fixtureError).toBeUndefined()
    if(report.port!==null)expect(report.portReleased).toBe(true)
    if(args[0]==='glob-abort'||args[0]==='vite-server')expect(report.temporaryDirectoryRemoved).toBe(true)
    process.stdout.write(`DEVTOOL_FIXTURE ${JSON.stringify(report)}\n`)
    return (expectedExit===0?report.result:report.fixtureError) as Record<string,unknown>
  } finally {
    clearTimeout(deadline);clearTimeout(hardStop)
    if(child.pid!==undefined&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed.catch(()=>null)}
    try { if(port!==null){
      const server=net.createServer()
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port!,'127.0.0.1',resolve)})
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
      record('parent-confirmed-port-rebound-and-released')
    } } finally {
      await removeOwnedDirectory(directory)
      record('closed-and-parent-removed-directory')
    }
  }
}

describe('installed brace-expansion consumers',()=>{
  for(const branch of ['eslint','redoc','glob']){
    for(const vector of ['nested','members','post','apply'])it(`${branch}: bounds ${vector} parsing without stack exhaustion`,async()=>{
      expect(await fixture('brace',branch,vector)).toMatchObject({error:null})
    })
    it(`${branch}: bounds quadratic rewrite work before producing results`,async()=>{
      expect(await fixture('brace',branch,'rewrite')).toMatchObject({error:null,literal:true,count:1})
    })
    it(`${branch}: preserves ordinary Cartesian expansion`,async()=>{
      expect(await fixture('brace',branch,'control')).toMatchObject({error:null,control:['a/x1','a/x2','b/x1','b/x2']})
    })
  }
})
describe('owned fixture failure cleanup',()=>{
  it('closes and removes its fixture after an exception',async()=>{
    expect(await fixtureExit(1,'cleanup-error')).toMatchObject({name:'Error',message:'owned synthetic exception'})
  })
  it('closes and removes its fixture after the cooperative deadline',async()=>{
    expect(await fixtureExit(2,'cleanup-deadline')).toMatchObject({name:'OwnedDeadline'})
  })
})
describe('generator and coverage input budgets',()=>{
  it('counts empty YAML merge sources against the configured budget',async()=>{
    expect(await fixture('yaml','limited')).toMatchObject({error:'YAMLException',message:'merge keys exceeded maxTotalMergeKeys (4)'})
  })
  it('accepts the same empty YAML merges within budget',async()=>{
    expect(await fixture('yaml','control')).toMatchObject({error:null,targets:[{},{}]})
  })
  for(const offset of ['huge','infinity','nan','fractional','negative','unsafe','nested'])it(`rejects ${offset} indexed source-map offsets before amplification`,async()=>{
    const result=await fixture('sourcemap',offset)
    expect(result.error).toBe('Error')
    expect(result.message).toMatch(/^Section offset (line|line and column) /)
  })
  it('maps an ordinary indexed source-map section correctly',async()=>{
    expect(await fixture('sourcemap','control')).toMatchObject({error:null,position:{source:'input.js',line:1,column:0}})
  })
})
describe('actual migration dependency boundaries',()=>{
  it('caps minimatch preprocessing amplification',async()=>{
    const result=await fixture('minimatch')
    expect(result.parts).toBeLessThanOrEqual(8);expect(result.control).toBe(true)
  })
  it('caps preprocessing in the TypeScript parser dependency too',async()=>{
    const result=await fixture('minimatch','estree')
    expect(result.parts).toBeLessThanOrEqual(8);expect(result.control).toBe(true)
  })
  it('preserves project-service allowlist matching in the actual TypeScript parser',async()=>{
    expect(await fixture('typescript-project')).toMatchObject({allowed:true,dotAllowed:true,denied:true})
  })
  it('preserves relative migration glob roots and ignore patterns',async()=>{
    expect(await fixture('migration-relative')).toEqual({names:['2_b.sql','10_z.sql']})
  })
  it('caps amplification in the actual default glob bundle as well',async()=>{
    const result=await fixture('glob-amplification')
    expect(result.patterns).toBeLessThanOrEqual(8);expect(result.control).toBeGreaterThan(0)
  })
  for(const vector of ['nested','post'])it(`bounds ${vector} brace parsing inside the default glob bundle`,async()=>{
    expect(await fixture('glob-brace',vector)).toMatchObject({error:null,control:true})
  })
  it('preserves POSIX character classes in the default glob bundle',async()=>{
    expect(await fixture('glob-classes')).toEqual({print:['!','$','1','A'],punct:['!','$']})
  })
  for(const mode of ['promise','stream','pre-promise','pre-stream'])it(`${mode}: performs no new directory reads after cancellation`,async()=>{
    expect(await fixture('glob-abort',mode)).toMatchObject({error:'owned-probe-abort',afterAbort:0,afterReject:0,pending:0})
  })
  it('still discovers files without cancellation',async()=>{
    expect(await fixture('glob-abort','control')).toMatchObject({error:null,count:9,afterAbort:0,pending:0})
  })
  it('does not install the optional shell-executing glob CLI',async()=>{
    expect(await fixture('glob-cli')).toEqual({binExposed:false,legacyEntryExists:false,libraryCallable:true})
  })
})
describe('installed bundled editor argument boundaries in an isolated VM',()=>{
  it('blocks percent expansion before Windows shell invocation',async()=>{
    const result=await fixture('editor','percent')
    expect(result.control).toHaveLength(1);expect(result.calls).toEqual([])
  })
  it('normalizes the Windows parent-path existence bypass before invocation',async()=>{
    const result=await fixture('editor','parent')
    expect(result.control).toHaveLength(1);expect(JSON.stringify(result.calls)).not.toContain('%SYNTHETIC%')
  })
  it('passes WSL flag-shaped filenames as explicit relative paths',async()=>{
    const result=await fixture('editor','wsl')
    expect(result.control).toHaveLength(1);expect(result.calls).toMatchObject([{type:'spawn',args:['vim',['./+SYNTHETIC_COMMAND'],{stdio:'inherit'}]}])
  })
})
describe('real loopback Vite and mocker boundaries',()=>{
  let result:Record<string,unknown>
  beforeAll(async()=>{result=await fixture('vite-server')},45000)
  it('serves real modules and a valid WASM positive control',()=>{
    expect(result.control).toBe(true);expect(result.wasmControl).toBe(200)
  })
  it('does not turn an unchanged request URL into a cross-origin script',()=>{
    expect(result.htmlControl).toBe(true);expect(result.htmlExternal).toBe(false)
  })
  it('does not disclose the first bytes of a denied WASM input',()=>{
    expect(result.wasmStatus).toBe(403);expect(result.wasmLeaked).toBe(false)
  })
  it('does not authorize a host path through a root-relative import collision',()=>{
    expect(result.posixApplicable).toBe(process.platform!=='win32')
    if(result.posixApplicable){expect(result.importControl).toBe(200);expect(result.safePathStatus).toBe(403)}
    expect(result.safePathLeaked).toBe(false)
  })
  it('serializes manual mock URLs received over the actual WebSocket',()=>{
    expect(result.manualControl).toBe(true);expect(result.manualStatus).toBe(200);expect(result.manualEscaped).toBe(true)
  })
  it('serves an allowed redirect and rejects both traversal separators',()=>{
    expect(result.redirects).toMatchObject({safe:{status:200,inside:true,outside:false},slash:{status:404,outside:false},backslash:{status:404,outside:false}})
  })
})
