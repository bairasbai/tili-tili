import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFile, mkdtemp, mkdir, writeFile, rm, link, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const require=createRequire(import.meta.url)
const migrateRoot=dirname(require.resolve('node-pg-migrate/package.json'))
const migrationRequire=createRequire(join(migrateRoot,'package.json'))
const {getMigrationFilePaths}=require(join(migrateRoot,'dist/migration.js')) as {
  getMigrationFilePaths:(dir:string|string[],options?:{useGlob?:boolean;ignorePattern?:string|string[]})=>Promise<string[]>
}
const directories:string[]=[]
const normalize=(value:string)=>value.replaceAll('\\','/')
async function temporary(){
  const value=await mkdtemp(join(tmpdir(),`tili-migration-glob-${process.pid}-`))
  directories.push(value)
  process.stdout.write(`MIGRATION_GLOB_FIXTURE ${JSON.stringify({owner:'migration-glob-compatibility',pid:process.pid,startedAt:new Date(Date.now()-process.uptime()*1000).toISOString(),cwd:process.cwd(),command:process.argv,path:value,state:'created'})}\n`)
  return value
}
afterEach(async()=>{
  for(const directory of directories.splice(0)){
    if(dirname(directory)!==resolve(tmpdir()))throw Error('Owned fixture escaped its temporary parent')
    await rm(directory,{recursive:true})
    process.stdout.write(`MIGRATION_GLOB_FIXTURE ${JSON.stringify({owner:'migration-glob-compatibility',pid:process.pid,path:directory,state:'removed'})}\n`)
  }
})
async function layout(){
  const root=await temporary()
  const names=['10_z.sql','2_b.sql','2_a10.sql','2_a2.sql','100_русский пробел.sql']
  for(const name of names)await writeFile(join(root,name),'-- synthetic migration\n')
  await writeFile(join(root,'.ignored.sql'),'-- synthetic hidden\n')
  await mkdir(join(root,'3_directory.sql'))
  await mkdir(join(root,'nested'));await writeFile(join(root,'nested','20_nested.sql'),'-- synthetic nested\n')
  return root
}
describe('pinned node-pg-migrate real glob compatibility',()=>{
  it('discovers all 101 reviewed migration files in the same order',async()=>{
    const plain=await getMigrationFilePaths(resolve('migrations'))
    const glob=await getMigrationFilePaths(normalize(resolve('migrations'))+'/*',{useGlob:true})
    expect(plain).toHaveLength(101);expect(glob).toEqual(plain)
    expect(new Set(glob).size).toBe(101)
  })
  it('preserves numeric and natural-name order, unicode, spaces and nodir',async()=>{
    const root=await layout()
    const expected=['2_a2.sql','2_a10.sql','2_b.sql','10_z.sql','100_русский пробел.sql'].map(name=>join(root,name))
    expect(await getMigrationFilePaths(root)).toEqual(expected)
    expect(await getMigrationFilePaths(normalize(root)+'/*',{useGlob:true})).toEqual(expected)
  })
  it('accepts multiple glob roots and ignore patterns without duplicates',async()=>{
    const root=await layout(),globRoot=normalize(root)
    // These roots are outside cwd; absolute ignores avoid globstar's deliberate
    // refusal to consume '..' in their cwd-relative representation.
    const filtered=await getMigrationFilePaths([globRoot+'/2_*.sql',globRoot+'/nested/*.sql',globRoot+'/2_b.sql'],{useGlob:true,ignorePattern:[globRoot+'/2_a*.sql']})
    expect(filtered,JSON.stringify(filtered)).toEqual([join(root,'2_b.sql'),join(root,'nested','20_nested.sql')])
    expect(await getMigrationFilePaths(globRoot+'/*',{useGlob:true,ignorePattern:globRoot+'/2_*.sql'})).toEqual([join(root,'10_z.sql'),join(root,'100_русский пробел.sql')])
  })
  it('retains empty-match and invalid-option failure semantics',async()=>{
    const root=await layout()
    expect(await getMigrationFilePaths(normalize(root)+'/missing*.sql',{useGlob:true})).toEqual([])
    await expect(getMigrationFilePaths(join(root,'missing'))).rejects.toMatchObject({code:'ENOENT'})
    await expect(getMigrationFilePaths([root])).rejects.toThrow('can only be arrays when "useGlob" is true')
    await expect(getMigrationFilePaths(root,{ignorePattern:['one','two']})).rejects.toThrow('can only be arrays when "useGlob" is true')
  })
  it('provides Path.name/fullpath and matching CJS/ESM/sync library results',async()=>{
    const root=await temporary(),first=join(root,'1_файл с пробелом.sql'),second=join(root,'2_link.sql')
    await writeFile(first,'-- synthetic file link\n')
    if(process.platform==='win32')await link(first,second)
    else await symlink(first,second,'file')
    const cjs=migrationRequire('glob') as {glob:(pattern:string,options:{withFileTypes:true})=>Promise<{name:string;fullpath:()=>string}[]>;globSync:(pattern:string,options:{withFileTypes:true})=>{name:string;fullpath:()=>string}[]}
    const pkg=migrationRequire('glob/package.json') as {exports:{'.':{import:{default:string}}}}
    const esm=await import(pathToFileURL(join(dirname(migrationRequire.resolve('glob/package.json')),pkg.exports['.'].import.default)).href) as typeof cjs
    const pattern=normalize(root)+'/*.sql',options={withFileTypes:true as const}
    for(const result of [await cjs.glob(pattern,options),cjs.globSync(pattern,options),await esm.glob(pattern,options)]){
      expect(result.map(value=>value.fullpath()).sort()).toEqual([first,second].sort())
      expect(result.map(value=>value.name).sort()).toEqual(['1_файл с пробелом.sql','2_link.sql'])
    }
    expect(await getMigrationFilePaths(root)).toEqual([first,second])
    expect(await getMigrationFilePaths(pattern,{useGlob:true})).toEqual([first,second])
  })
  it('keeps the native migration CLI available without the removed optional glob CLI',async()=>{
    const cli=join(migrateRoot,'bin/node-pg-migrate.js')
    for(const argument of ['--version','--help']){
      const child=spawn(process.execPath,[cli,argument],{windowsHide:true,stdio:['ignore','pipe','pipe']})
      const createdAt=new Date().toISOString()
      process.stdout.write(`MIGRATION_CLI_FIXTURE ${JSON.stringify({owner:'migration-glob-compatibility',pid:child.pid,startedAt:createdAt,cwd:process.cwd(),command:[process.execPath,cli,argument],state:'started'})}\n`)
      let output='',errorOutput=''
      child.stdout.on('data',chunk=>{output+=String(chunk)});child.stderr.on('data',chunk=>{errorOutput+=String(chunk)})
      const closed=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
      const deadline=setTimeout(()=>child.kill('SIGTERM'),5000)
      try{expect(await closed,errorOutput).toBe(0);expect(output).toContain(argument==='--version'?'7.9.1':'--use-glob')}
      finally{clearTimeout(deadline);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await closed}}
      process.stdout.write(`MIGRATION_CLI_FIXTURE ${JSON.stringify({owner:'migration-glob-compatibility',pid:child.pid,startedAt:createdAt,state:'closed',exit:child.exitCode})}\n`)
    }
    expect((await readFile(cli)).length).toBeGreaterThan(0)
  })
})
