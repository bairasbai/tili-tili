// Bounded synthetic probes of installed devtools. No application DB or secrets.
import * as fs from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import net from 'node:net'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'

const scenario = process.argv[2]
const variant = process.argv[3]
const require = createRequire(new URL('../../package.json', import.meta.url))
const migrateRequire = createRequire(require.resolve('node-pg-migrate/package.json'))
const redocRequire = createRequire(createRequire(require.resolve('openapi-typescript/package.json')).resolve('@redocly/openapi-core/package.json'))
const vitestRequire = createRequire(require.resolve('vitest/package.json'))
const globRequire = createRequire(migrateRequire.resolve('glob/package.json'))
const owner = process.env.DEVTOOL_FIXTURE_OWNER ?? `devtool-security/${process.env.GITHUB_RUN_ID ?? 'local'}`
const report = { owner, pid: process.pid, startedAt: new Date(Date.now() - process.uptime()*1000).toISOString(), command: process.argv, cwd: process.cwd(), scenario, variant, port: null, portReleased: false, temporaryDirectoryRemoved: false, events: [] }
function record(state) {
  const event = { owner, pid: report.pid, startedAt: report.startedAt, command: report.command, cwd: report.cwd, scenario, variant, port: report.port, state, at: new Date().toISOString() }
  report.events.push(event)
  if(process.connected)process.send({type:'owned-fixture-state',port:report.port})
  if (process.env.DEVTOOL_FIXTURE_EVIDENCE) fs.appendFileSync(process.env.DEVTOOL_FIXTURE_EVIDENCE, JSON.stringify(event)+'\n')
}
record('started')
let directory, vite, socket, globStream, finishing, ownedServer
function shutdown(){report.fixtureError={name:'OwnedDeadline',message:'Owned fixture shutdown requested'};process.exitCode=2;void finish().then(()=>process.exit(2))}
const watchdog = setTimeout(shutdown,scenario==='cleanup-deadline'?200:scenario==='vite-server'?30_000:12_000)
process.on('SIGTERM',shutdown)
process.on('message',message=>{if(message==='shutdown')shutdown()})
async function temp() {
  directory = process.env.DEVTOOL_FIXTURE_DIRECTORY ?? await mkdtemp(path.join(tmpdir(), `tili-devtool-owned-${process.pid}-`))
  if(path.dirname(directory)!==path.resolve(tmpdir()))throw Error('Owned fixture directory escaped temporary parent')
  report.temporaryDirectory = directory
  record('created-synthetic-directory')
  return directory
}
const tick = () => new Promise(resolve => setImmediate(resolve))
async function probe() {
  if(scenario==='cleanup-error'||scenario==='cleanup-deadline'){
    await temp()
    ownedServer=net.createServer()
    await new Promise((resolve,reject)=>{ownedServer.once('error',reject);ownedServer.listen(0,'127.0.0.1',resolve)})
    report.port=ownedServer.address().port;record('listening-loopback')
    if(scenario==='cleanup-error')throw Error('owned synthetic exception')
    return await new Promise(()=>{})
  }
  if (scenario === 'brace') {
    const req = variant === 'eslint' ? createRequire(createRequire(require.resolve('eslint/package.json')).resolve('minimatch/package.json'))
      : variant === 'redoc' ? createRequire(redocRequire.resolve('minimatch/package.json'))
        : createRequire(globRequire.resolve('minimatch/package.json'))
    const module = req('brace-expansion')
    const expand = typeof module === 'function' ? module : module.expand
    const kind = process.argv[4]
    const input = kind === 'nested' ? '{'.repeat(6000)+'a,b'+'}'.repeat(6000)
      : kind === 'members' ? '{a,'.repeat(6000)+'z'+'}'.repeat(6000)
        : kind === 'post' ? '{'+'{a},'.repeat(10000)+'b}'
          : kind === 'apply' ? '{{x},'+'a,'.repeat(140000)+'b}'
            : kind === 'rewrite' ? '{a}'+'}'.repeat(64)+',z}' : '{a,b}/x{1..2}'
    try {
      const result = expand(input, { max: 16, maxLength: 4096, maxRewrites: 2 })
      return { kind, error: null, count: result.length, literal: result.length === 1 && result[0] === input, control: kind === 'control' ? result : undefined }
    } catch (error) { return { kind, error: error.name, message: error.message } }
  }
  if (scenario === 'yaml') {
    const yaml = redocRequire('js-yaml')
    const source = 'arr: &arr [{}, {}, {}]\ntargets:\n  - <<: *arr\n  - <<: *arr\n'
    try { const value = yaml.load(source, { maxTotalMergeKeys: variant === 'limited' ? 4 : 6 }); return { error: null, targets: value.targets } }
    catch (error) { return { error: error.name, message: error.reason } }
  }
  if (scenario === 'sourcemap') {
    const mapRequire = createRequire(createRequire(require.resolve('@vitest/coverage-v8/package.json')).resolve('magicast/package.json'))
    const { SourceMapConsumer } = mapRequire('source-map-js')
    const basic = { version: 3, sources: ['input.js'], names: [], mappings: 'AAAA' }
    const indexed = (line, column = 0, map = basic) => ({ version: 3, sections: [{ offset: { line, column }, map }] })
    const inputs = { huge: indexed(10000001), infinity: indexed(Infinity), nan: indexed(NaN), fractional: indexed(0.5), negative: indexed(0,-1), unsafe: indexed(0,Number.MAX_SAFE_INTEGER+1), nested: indexed(6000000,0,indexed(6000000)), control: indexed(2,3) }
    try {
      const consumer = new SourceMapConsumer(inputs[variant])
      return { error: null, position: variant === 'control' ? consumer.originalPositionFor({ line: 3, column: 4 }) : undefined }
    } catch (error) { return { error: error.name, message: error.message } }
  }
  if (scenario === 'minimatch') {
    const estreeRequire=createRequire(require.resolve('@typescript-eslint/typescript-estree/package.json'))
    const { Minimatch } = (variant==='estree'?estreeRequire:globRequire)('minimatch')
    const matcher = new Minimatch('', { optimizationLevel: 2, braceExpandMax: 8 })
    const pattern = 'a/**/../b/c/'.repeat(7)+'target.js'
    return { parts: matcher.firstPhasePreProcess([pattern.split('/')]).length, control: new Minimatch('**/*.{js,ts}', { optimizationLevel: 2 }).match('src/a.ts') }
  }
  if(scenario==='typescript-project'){
    const parser=require('@typescript-eslint/typescript-estree')
    const root=await temp()
    const code='export const answer = 42\n'
    for(const file of ['allowed.js','.allowed.js','denied.js','included.ts'])await writeFile(path.join(root,file),code)
    await writeFile(path.join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{allowJs:true,checkJs:true},files:['included.ts']}))
    const options=file=>({filePath:path.join(root,file),tsconfigRootDir:root,projectService:{allowDefaultProject:['allowed*.js','.allowed.js'],defaultProject:'tsconfig.json'}})
    try{
      const allowed=parser.parseAndGenerateServices(code,options('allowed.js'))
      const dot=parser.parseAndGenerateServices(code,options('.allowed.js'))
      let denied=false
      try{parser.parseAndGenerateServices(code,options('denied.js'))}catch(error){if(!error.message.includes('was not found by the project service'))throw error;denied=true}
      return{allowed:allowed.ast.type==='Program'&&!!allowed.services.program.getSourceFile(path.join(root,'allowed.js')),dotAllowed:dot.ast.type==='Program'&&!!dot.services.program.getSourceFile(path.join(root,'.allowed.js')),denied}
    }finally{parser.clearCaches()}
  }
  if(scenario==='migration-relative'){
    const root=await temp(),before=process.cwd()
    await mkdir(path.join(root,'migrations'))
    for(const name of ['2_a2.sql','2_a10.sql','2_b.sql','10_z.sql'])await writeFile(path.join(root,'migrations',name),'-- synthetic\n')
    try{
      process.chdir(root)
      const {getMigrationFilePaths}=require(path.join(path.dirname(require.resolve('node-pg-migrate/package.json')),'dist/migration.js'))
      const files=await getMigrationFilePaths(['migrations/2_*.sql','migrations/10_*.sql'],{useGlob:true,ignorePattern:['**/2_a*.sql']})
      return{names:files.map(file=>path.basename(file))}
    }finally{process.chdir(before)}
  }
  if (scenario === 'glob-amplification') {
    // Exercise the actual default bundle required by the pinned migration tool.
    const { Glob } = migrateRequire('glob')
    const walk = new Glob('a/**/../b/c/'.repeat(7)+'target.js', { braceExpandMax: 8 })
    return { patterns: walk.patterns.length, control: new Glob('src/*.{js,ts}', {}).patterns.length }
  }
  if(scenario==='glob-brace'){
    const {Glob}=migrateRequire('glob')
    const input=variant==='nested'?'{'.repeat(6000)+'a,b'+'}'.repeat(6000):'{'+'{a},'.repeat(10000)+'b}'
    try {new Glob(input,{braceExpandMax:16});return{error:null,control:new Glob('src/{a,b}/*.sql',{}).patterns.length>0}}
    catch(error){return{error:error.name,message:error.message}}
  }
  if(scenario==='glob-classes'){
    const root=await temp()
    for(const name of ['A','1','!','$'])await writeFile(path.join(root,name),'synthetic')
    const {glob}=migrateRequire('glob')
    return{print:(await glob('[[:print:]]',{cwd:root})).sort(),punct:(await glob('[[:punct:]]',{cwd:root})).sort()}
  }
  if (scenario === 'glob-abort') {
    const { glob, globStream: stream } = migrateRequire('glob')
    const root = await temp()
    for (let i=0;i<3;i++) for (let j=0;j<3;j++) {
      const dir = path.join(root, `a${i}`, `b${j}`)
      await mkdir(dir,{recursive:true}); await writeFile(path.join(dir,'sample.txt'),'synthetic')
    }
    const controller = new AbortController()
    const stats = { reads: 0, afterAbort: 0, afterReject: 0, pending: 0 }
    let release, ready, rejected = false
    const held = new Promise(resolve => { ready = resolve })
    const counted = { ...fs, readdir(p, options, callback) {
      stats.reads++; stats.pending++
      if (controller.signal.aborted) stats.afterAbort++
      if (rejected) stats.afterReject++
      fs.readdir(p,options,(error,entries) => {
        const deliver = () => { stats.pending--; callback(error,entries) }
        if (!release && !variant.startsWith('pre-') && variant !== 'control') { release = deliver; ready() } else deliver()
      })
    } }
    const reason = new Error('owned-probe-abort')
    if (variant.startsWith('pre-')) controller.abort(reason)
    let settled
    const options = { cwd: root, fs: counted, signal: controller.signal, nodir: true }
    if (variant.includes('stream')) {
      globStream = stream('**/*',options)
      settled = new Promise(resolve => {
        if (globStream.aborted) { rejected=true; resolve({error:controller.signal.reason.message}); return }
        globStream.once('error',error => { rejected=true; resolve({ error: error.message }) })
        globStream.once('end',() => resolve({ error:null }))
        globStream.resume()
      })
    } else settled = glob('**/*',options).then(matches => ({error:null,count:matches.length}),error => { rejected=true; return {error:error.message} })
    if (!variant.startsWith('pre-') && variant !== 'control') { await held; controller.abort(reason); release() }
    const result = await settled
    let stable=0
    while (stable<3) { await tick(); stable = stats.pending === 0 ? stable+1 : 0 }
    return { ...result, ...stats }
  }
  if (scenario === 'glob-cli') {
    const pkg = migrateRequire('glob/package.json')
    const root = path.dirname(migrateRequire.resolve('glob/package.json'))
    return { binExposed: !!pkg.bin, legacyEntryExists: fs.existsSync(path.join(root,'dist/esm/bin.mjs')), libraryCallable: typeof migrateRequire('glob').glob === 'function' }
  }
  if (scenario === 'editor') {
    // Run the exact installed bundled launch-editor module in a VM with virtual
    // fs/process/child_process boundaries. Never start an editor or a shell.
    const viteRoot = path.dirname(vitestRequire.resolve('vite/package.json'))
    const bundle = fs.readFileSync(path.join(viteRoot,'dist/node/chunks/node.js'),'utf8')
    const start = bundle.search(/\/\/#region .*launch-editor@[^\n]+\/editor-info\/macos\.js/)
    const end = bundle.indexOf('//#region ',bundle.indexOf('//#endregion',bundle.indexOf('module.exports = launchEditor;',start)))
    if (start<0 || end<0) throw Error('Installed editor bundle boundary missing')
    const calls = []
    const platform = variant === 'wsl' ? 'linux' : 'win32'
    const p = platform === 'linux' ? path.posix : path.win32
    const cwd = platform === 'linux' ? '/mnt/project' : 'C:\\fixture'
    const virtualPath = { ...p, win32:path.win32, resolve: (...args) => p.resolve(cwd,...args), relative: (a,b) => p.relative(a || cwd,b) }
    const child = () => Object.assign(new EventEmitter(),{kill(){this.emit('exit',0);return true}})
    const builtins = {
      path: virtualPath, os:{ release:()=> 'Microsoft WSL' }, url:{ fileURLToPath:()=>{throw Error('Unused URL boundary')} },
      fs:{ existsSync:()=>true },
      child_process:{ exec:(...args)=>{calls.push({type:'exec',args});return child()}, spawn:(...args)=>{calls.push({type:'spawn',args});return child()}, execSync:()=>{throw Error('No process enumeration allowed')} },
    }
    const context = vm.createContext({ process:{platform,cwd:()=>cwd,env:{LAUNCH_EDITOR:variant==='wsl'?'vim':'fixture-editor.cmd'},versions:{}}, console:{log:()=>undefined}, __require:name=>{if(!(name in builtins))throw Error(`Unexpected builtin ${name}`);return builtins[name]}, __commonJSMin:factory=>{let module;return()=>{if(!module){module={exports:{}};factory(module.exports,module)}return module.exports}}, require_shell_quote:()=>({parse:()=>{throw Error('Unused shell parser')}}),require_picocolors:()=>({red:x=>x}) })
    vm.runInContext(bundle.slice(start,end)+'\nglobalThis.launch = require_launch_editor();',context,{timeout:1000})
    const normal = platform==='linux'?'/mnt/project/normal.txt':'C:\\fixture\\normal.txt'
    context.launch(normal)
    const control = calls.splice(0)
    const malicious = variant==='wsl'?'/mnt/project/+SYNTHETIC_COMMAND':variant==='percent'?'C:\\fixture\\report%SYNTHETIC%.txt':'C:\\fixture\\%SYNTHETIC%\\..:1:1'
    context.launch(malicious)
    return { control, calls }
  }
  if (scenario === 'vite-server') {
    const { createServer } = await import(pathToFileURL(vitestRequire.resolve('vite')).href)
    const { interceptorPlugin } = await import(pathToFileURL(vitestRequire.resolve('@vitest/mocker/node')).href)
    const { WebSocket } = createRequire(require.resolve('@fastify/websocket/package.json'))('ws')
    const base = await temp(), root = path.join(base,'root')
    await mkdir(root)
    await writeFile(path.join(root,'package.json'),'{}')
    await writeFile(path.join(root,'app.js'),'export const value="REAL_CONTROL"')
    await writeFile(path.join(root,'manual-safe.js'),'export const value="REAL_CONTROL"')
    await writeFile(path.join(root,'manual-attack.js'),'export const value="REAL_CONTROL"')
    await writeFile(path.join(root,'allowed.js'),'export const value="INSIDE_CONTROL"')
    await writeFile(path.join(root,'valid.wasm'),Buffer.from('0061736d01000000','hex'))
    await writeFile(path.join(root,'denied.txt'),'QZXY_SYNTHETIC_DENIED_CANARY')
    const outside = path.join(base,'outside.js'), canary='QZXY_SYNTHETIC_OUTSIDE_CANARY'
    await writeFile(outside,`export const value="${canary}"`)
    const normalized = p => p.replaceAll('\\','/')
    if (process.platform !== 'win32') {
      const decoy = path.join(root,outside.slice(1))
      await mkdir(path.dirname(decoy),{recursive:true});await writeFile(decoy,'export const value="PROJECT_DECOY"')
      await writeFile(path.join(root,'main.js'),`import './${outside.slice(1)}'`)
    }
    vite = await createServer({ root, configFile:false, envFile:false, logLevel:'silent',cacheDir:path.join(base,'cache'), optimizeDeps:{noDiscovery:true,include:[]},server:{host:'127.0.0.1',port:0,watch:null,fs:{strict:true,allow:[root],deny:['**/denied.txt']}},plugins:[{name:'synthetic:virtual',enforce:'pre',resolveId(id){if(id.startsWith('/redirect-'))return id}},interceptorPlugin()] })
    await vite.listen()
    report.port = vite.httpServer.address().port; record('listening-loopback')
    const baseUrl=`http://127.0.0.1:${report.port}`
    const request = async url => { const response=await fetch(baseUrl+url,{headers:{connection:'close'},signal:AbortSignal.timeout(3000)});return{status:response.status,body:await response.text()} }
    const control = await request('/app.js')
    const html = '<script type="module">globalThis.fixture=true</script>'
    const validHtml = await vite.transformIndexHtml('/index.html',html)
    let attackHtml='',htmlError=null
    try { attackHtml=await vite.transformIndexHtml('//attacker.invalid/payload.js?/../../package.json',html) } catch(error){htmlError=error.message}
    const wasmControl=await request('/valid.wasm?vite-wasm-instance')
    const wasm=await request('/denied.txt?vite-wasm-instance&import')
    let safePath={status:null,body:''},importControl={status:null,body:''}
    if(process.platform!=='win32'){importControl=await request('/main.js');safePath=await request('/@fs'+outside)}
    socket=new WebSocket(`ws://127.0.0.1:${report.port}`,'vite-hmr')
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)})
    let acknowledge
    socket.on('message',raw=>{
      const message=JSON.parse(raw.toString())
      if(message.type==='custom'&&message.event==='vitest:interceptor:resolve') socket.send(JSON.stringify({type:'custom',event:'vitest:interceptor:resolved',data:{url:message.data,keys:['value']}}))
      if(message.type==='custom'&&message.event==='vitest:interceptor:register:result') acknowledge?.()
    })
    const register = data => new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Owned registration timeout')),3000)
      acknowledge=()=>{clearTimeout(timer);resolve()}
      socket.send(JSON.stringify({type:'custom',event:'vitest:interceptor:register',data}))
    })
    await register({type:'manual',raw:'',id:normalized(path.join(root,'manual-safe.js')),url:'/harmless'})
    const manualControl=await request('/manual-safe.js')
    const payload='x"); globalThis.SYNTHETIC_INJECTED = 1; void("'
    await register({type:'manual',raw:'',id:normalized(path.join(root,'manual-attack.js')),url:payload})
    const manual=await request('/manual-attack.js')
    const redirects={}
    for(const [name,redirect] of [['safe','fixture:/allowed.js'],['slash','fixture:../outside.js'],['backslash','fixture:..\\outside.js']]){
      const id=`/redirect-${name}`
      await register({type:'redirect',raw:'',id,url:id,redirect})
      const response=await request(id);redirects[name]={status:response.status,inside:response.body.includes('INSIDE_CONTROL'),outside:response.body.includes(canary)}
    }
    return { control:control.status===200&&control.body.includes('REAL_CONTROL'),htmlControl:validHtml.includes('html-proxy'),htmlExternal:attackHtml.includes('src="//attacker.invalid/'),htmlError,wasmControl:wasmControl.status,wasmStatus:wasm.status,wasmLeaked:/51 5a 58 59/i.test(wasm.body),posixApplicable:process.platform!=='win32',importControl:importControl.status,safePathStatus:safePath.status,safePathLeaked:safePath.body.includes(canary),manualControl:manualControl.status===200&&manualControl.body.includes('getFactoryModule("/harmless")'),manualStatus:manual.status,manualEscaped:manual.body.includes(JSON.stringify(payload)),redirects }
  }
  throw Error(`Unknown owned scenario ${scenario}`)
}
function finish(){
  return finishing??=(async()=>{
  try {
  if(socket){if(socket.readyState!==3)await new Promise(resolve=>{socket.once('close',resolve);socket.terminate()});record('closed-websocket')}
  globStream?.destroy()
  if(ownedServer)await new Promise((resolve,reject)=>ownedServer.close(error=>error?reject(error):resolve()))
  if(vite)await vite.close()
  if(report.port!==null){
    const server=net.createServer()
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(report.port,'127.0.0.1',resolve)})
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
    report.portReleased=true;record('closed-port-rebound-and-released')
  }
  }catch(error){report.cleanupError={name:error.name,message:error.message};process.exitCode=1}
  finally {
  if(directory){await rm(directory,{recursive:true});report.temporaryDirectoryRemoved=!fs.existsSync(directory);record('removed-synthetic-directory')}
  clearTimeout(watchdog);record('finished')
  process.stdout.write(JSON.stringify(report)+'\n')
  if(process.connected)process.disconnect()
  }
  })()
}
try { report.result=await probe() }
catch(error){report.fixtureError={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally { await finish() }
