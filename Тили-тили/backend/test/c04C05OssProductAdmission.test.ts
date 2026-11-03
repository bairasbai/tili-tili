import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertJournal, assertMigrationFiles, fileSHA, reviewedMigrationPins, verifyMigrationDirectory, verifySource } from '../test-support/c04-c05-native-admission.mjs'
import { HISTORICAL94_PATHS } from './helpers/c04C05SourceFixture.js'

// Independently declared literal pins: never computed from the current DDL to admit it.
const invitation95={name:'1764800000000_invitation_designs',sha256:'751F70916DA4E31284CD6D456D4DDF1BC2D0743C95613054F13CC78829E5327B'}
const tilly96={name:'1764810000000_tilly_task_actions',sha256:'25E3AD028D498E1C3C76C256A44B4FFFAE05F51421FC66875146F66FE6161383'}
const directory=resolve('migrations'),backend=realpathSync(resolve('.')),repo=realpathSync(resolve('../..'))
const current=reviewedMigrationPins(96),names=current.map(p=>p.name)
const newPaths=[
  'test-support/c04-c05-invitation-design-migrations.json','test-support/c04-c05-tilly-actions-migrations.json',
  'test/fixtures/oss031-animated.png','test/fixtures/oss031-animated.webp',
  'src/invitations/design.ts','src/routes/invitationDesign.ts','test/invitationDesign.test.ts',
  'test/ossProductMigrations.test.ts','test-support/oss-product-migration-drill.mjs',
  'src/tilly/actions.ts','test/tillyActions.test.ts','test/c04C05OssProductAdmission.test.ts',
].map(p=>'Тили-тили/backend/'+p)
function source96(){
  const paths=[...new Set([...HISTORICAL94_PATHS,...newPaths,...current.map(p=>'Тили-тили/backend/migrations/'+p.name+'.cjs'),'Тили-тили/backend/migrations/data/categories.json','Тили-тили/backend/migrations/data/cities.json'])].sort()
  return{kind:'c04_c05_current_source96_v1' as const,backend,repo,files:paths.map(path=>({path,sha256:fileSHA(join(repo,path))}))}
}
const parent=realpathSync(tmpdir()),owned=new Set<string>()
function fixture(){const root=mkdtempSync(join(parent,'c04c05-oss-'));owned.add(root);writeFileSync(join(root,'owner.json'),JSON.stringify({owner:'c04C05OssProductAdmission',root,purpose:'exact96 migration negative',result:'Vitest',cleanup:'afterEach'}));
  const target=join(root,'migrations');mkdirSync(target);mkdirSync(join(target,'data'))
  for(const p of current)copyFileSync(join(directory,p.name+'.cjs'),join(target,p.name+'.cjs'))
  for(const name of ['categories.json','cities.json'])copyFileSync(join(directory,'data',name),join(target,'data',name))
  return target}
afterEach(()=>{for(const root of owned){expect(dirname(root)).toBe(parent);expect(root.slice(parent.length+1)).toMatch(/^c04c05-oss-[A-Za-z0-9]+$/);expect(realpathSync(root)).toBe(root);rmSync(root,{recursive:true});owned.delete(root)}})
describe('closed independently pinned OSS schema95/96 admission',()=>{
  it('preserves all94 historical pins, separately admits95 and96 and validates every physical file and seed',()=>{
    expect(current.slice(0,94)).toEqual(reviewedMigrationPins(94));expect(current.slice(94)).toEqual([invitation95,tilly96]);expect(reviewedMigrationPins(95)).toEqual([...current.slice(0,94),invitation95])
    expect(verifyMigrationDirectory(directory,current)).toEqual(names);expect(()=>assertJournal(names,names)).not.toThrow()
    for(const p of [invitation95,tilly96])expect(fileSHA(join(directory,p.name+'.cjs'))).toBe(p.sha256)
    expect(()=>reviewedMigrationPins(97)).toThrow();expect(()=>reviewedMigrationPins(84)).toThrow()
  })
  it('accepts actual current96 SOURCE and refuses a downgraded kind on the physical96 directory',()=>{
    const source=source96();expect(verifySource(source)).toEqual(names)
    for(const kind of ['c04_c05_current_source94_v1','c04_c05_current_source95_v1'] as const)expect(()=>verifySource({...source,kind})).toThrow()
  })
  it.each(newPaths)('requires input %s after a positive current96 control',omitted=>{
    const source=source96();expect(verifySource(source)).toEqual(names);expect(source.files.length-1).toBeGreaterThan(100)
    expect(()=>verifySource({...source,files:source.files.filter(p=>p.path!==omitted)})).toThrow()
  })
  it.each([94,95])('rejects byte tampering and caller-rehashing at new index%s',index=>{
    const target=fixture(),file=join(target,current[index]!.name+'.cjs');expect(verifyMigrationDirectory(target,current)).toEqual(names)
    writeFileSync(file,readFileSync(file,'utf8')+'\n// tampered\n');expect(()=>verifyMigrationDirectory(target,current)).toThrow()
    const forged=current.map(p=>({...p}));forged[index]!.sha256=fileSHA(file);expect(()=>verifyMigrationDirectory(target,forged)).toThrow()
  })
  it('refuses missing, renamed, duplicate and nonregular metadata, extra migrations and changed seeds',()=>{
    const entries=readdirSync(directory,{withFileTypes:true});expect(()=>assertMigrationFiles(entries,current)).not.toThrow()
    expect(()=>assertMigrationFiles(entries.filter(e=>e.name!==tilly96.name+'.cjs'),current)).toThrow()
    expect(()=>assertMigrationFiles([...entries,entries[0]!],current)).toThrow()
    expect(()=>assertMigrationFiles(entries.map(e=>e.name===invitation95.name+'.cjs'?{name:'1764820000000_unknown.cjs',isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false}:e),current)).toThrow()
    expect(()=>assertMigrationFiles(entries.map(e=>e.name===tilly96.name+'.cjs'?{name:e.name,isFile:()=>false,isDirectory:()=>false,isSymbolicLink:()=>true}:e),current)).toThrow()
    const target=fixture(),seed=join(target,'data/cities.json');expect(verifyMigrationDirectory(target,current)).toEqual(names)
    writeFileSync(seed,readFileSync(seed,'utf8')+'\n');expect(()=>verifyMigrationDirectory(target,current)).toThrow()
  })
})
