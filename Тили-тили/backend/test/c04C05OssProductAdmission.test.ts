import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertJournal, assertMigrationFiles, fileSHA, reviewedMigrationPins, verifyMigrationDirectory } from '../test-support/c04-c05-native-admission.mjs'
import { HISTORICAL94_PATHS, freezeHistoricalSource, verifyHistoricalSource, cleanHistoricalSources } from './helpers/c04C05SourceFixture.js'

// Independently declared literal pins: never computed from the current DDL to admit it.
const invitation96={name:'1764800000000_invitation_designs',sha256:'751F70916DA4E31284CD6D456D4DDF1BC2D0743C95613054F13CC78829E5327B'}
const tilly97={name:'1764810000000_tilly_task_actions',sha256:'25E3AD028D498E1C3C76C256A44B4FFFAE05F51421FC66875146F66FE6161383'}
const audit98={name:'1764820000000_calendar_adoption_audit_fixes',sha256:'22F15D21C3FC04AB15FB4C1D55A6F8F16BCC4CAD1A93B6C5E3FC7D8C174C8F45'}
const directory=resolve('migrations'),backend=realpathSync(resolve('.')),repo=realpathSync(resolve('../..'))
const current=reviewedMigrationPins(98),names=current.map(p=>p.name)
const newPaths=[
  'test-support/c04-c05-adoption-migrations.json','test-support/c04-c05-invitation-design-migrations.json','test-support/c04-c05-tilly-actions-migrations.json',
  'test/fixtures/oss031-animated.png','test/fixtures/oss031-animated.webp',
  'src/invitations/design.ts','src/routes/invitationDesign.ts','test/invitationDesign.test.ts',
  'test/ossProductMigrations.test.ts','test-support/oss-product-migration-drill.mjs',
  'src/tilly/actions.ts','test/tillyActions.test.ts','test/c04C05OssProductAdmission.test.ts',
  'test-support/c04-c05-adoption-audit-migrations.json','test-support/calendar-adoption-audit-migration-drill.mjs',
  'test-support/ecosystem-snapshot.mjs',
  'src/orders/terms.ts','src/routes/orders.ts','test/resourceAdoption372.test.ts','test/ecosystemDelivery.test.ts','test/orderResourcePlan.test.ts',
].map(p=>'Тили-тили/backend/'+p).concat(['Тили-тили/app/src/components/OrderTerms.tsx','Тили-тили/app/src/components/OrderTerms.test.tsx'])
function source98(){
  const paths=[...new Set([...HISTORICAL94_PATHS,...newPaths,...current.map(p=>'Тили-тили/backend/migrations/'+p.name+'.cjs'),'Тили-тили/backend/migrations/data/categories.json','Тили-тили/backend/migrations/data/cities.json'])].sort()
  return freezeHistoricalSource({kind:'c04_c05_current_source98_v1' as const,backend,repo,files:paths.map(path=>({path,sha256:fileSHA(join(repo,path))}))})
}
const parent=realpathSync(tmpdir()),owned=new Set<string>()
function fixture(){const root=mkdtempSync(join(parent,'c04c05-oss-'));owned.add(root);writeFileSync(join(root,'owner.json'),JSON.stringify({owner:'c04C05OssProductAdmission',root,purpose:'exact98 migration negative',result:'Vitest',cleanup:'afterEach'}));
  const target=join(root,'migrations');mkdirSync(target);mkdirSync(join(target,'data'))
  for(const p of current)copyFileSync(join(directory,p.name+'.cjs'),join(target,p.name+'.cjs'))
  for(const name of ['categories.json','cities.json'])copyFileSync(join(directory,'data',name),join(target,'data',name))
  return target}
afterEach(()=>{cleanHistoricalSources();for(const root of owned){expect(dirname(root)).toBe(parent);expect(root.slice(parent.length+1)).toMatch(/^c04c05-oss-[A-Za-z0-9]+$/);expect(realpathSync(root)).toBe(root);rmSync(root,{recursive:true});owned.delete(root)}})
describe('closed independently pinned OSS schema96/97 and calendar audit98 admission',()=>{
  it('preserves all97 prior pins, separately admits98 and validates every physical file and seed',()=>{
    expect(current.slice(0,95)).toEqual(reviewedMigrationPins(95));expect(current.slice(95,97)).toEqual([invitation96,tilly97]);expect(reviewedMigrationPins(96)).toEqual([...current.slice(0,95),invitation96])
    expect(current.slice(0,97)).toEqual(reviewedMigrationPins(97));expect(current.at(-1)).toEqual(audit98)
    expect(verifyMigrationDirectory(fixture(),current)).toEqual(names);expect(()=>assertJournal(names,names)).not.toThrow()
    for(const p of [invitation96,tilly97,audit98])expect(fileSHA(join(directory,p.name+'.cjs'))).toBe(p.sha256)
    expect(()=>reviewedMigrationPins(114)).toThrow();expect(()=>reviewedMigrationPins(84)).toThrow()
  })
  it('accepts exact historical98 SOURCE and refuses downgraded or current99 kinds on its physical98 directory',()=>{
    const source=source98();expect(verifyHistoricalSource(source)).toEqual(names)
    for(const kind of ['c04_c05_current_source94_v1','c04_c05_current_source95_v1','c04_c05_current_source96_v1','c04_c05_current_source97_v1','c04_c05_current_source99_v1'] as const)expect(()=>verifyHistoricalSource({...source,kind})).toThrow()
  })
  it.each(newPaths)('requires input %s after a positive historical98 control',omitted=>{
    const source=source98();expect(verifyHistoricalSource(source)).toEqual(names);expect(source.files.length-1).toBeGreaterThan(100)
    expect(()=>verifyHistoricalSource({...source,files:source.files.filter(p=>p.path!==omitted)})).toThrow()
  })
  it.each([95,96,97])('rejects byte tampering and caller-rehashing at new index%s',index=>{
    const target=fixture(),file=join(target,current[index]!.name+'.cjs');expect(verifyMigrationDirectory(target,current)).toEqual(names)
    writeFileSync(file,readFileSync(file,'utf8')+'\n// tampered\n');expect(()=>verifyMigrationDirectory(target,current)).toThrow()
    const forged=current.map(p=>({...p}));forged[index]!.sha256=fileSHA(file);expect(()=>verifyMigrationDirectory(target,forged)).toThrow()
  })
  it('refuses missing, renamed, duplicate and nonregular metadata, extra migrations and changed seeds',()=>{
    const entries=readdirSync(fixture(),{withFileTypes:true});expect(()=>assertMigrationFiles(entries,current)).not.toThrow()
    expect(()=>assertMigrationFiles(entries.filter(e=>e.name!==tilly97.name+'.cjs'),current)).toThrow()
    expect(()=>assertMigrationFiles([...entries,entries[0]!],current)).toThrow()
    expect(()=>assertMigrationFiles(entries.map(e=>e.name===invitation96.name+'.cjs'?{name:'1764820000000_unknown.cjs',isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false}:e),current)).toThrow()
    expect(()=>assertMigrationFiles(entries.map(e=>e.name===tilly97.name+'.cjs'?{name:e.name,isFile:()=>false,isDirectory:()=>false,isSymbolicLink:()=>true}:e),current)).toThrow()
    const target=fixture(),seed=join(target,'data/cities.json');expect(verifyMigrationDirectory(target,current)).toEqual(names)
    writeFileSync(seed,readFileSync(seed,'utf8')+'\n');expect(()=>verifyMigrationDirectory(target,current)).toThrow()
  })
})
