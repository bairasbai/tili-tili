import type { Queryable } from '../src/plugins/db.js'
export interface Profile { mode:'local'|'github-ci';targetName:string;targetURL:string;username:string;port:number;fixedOID?:string;context?:Record<string,string> }
export interface Identity {name:string;username:string;port:number;address:string;oid:string;pid:number}
export interface Admission {profile:Profile;creation:Record<string,unknown>;schema:{journalNames:string[];retainedAudits:unknown[];triggers:unknown[];migrationCount:number};source:unknown;sourceSHA256:string;directory:string;targetName:string;targetURL:string;oid:string;stage:string}
export function readAdmission(stage:'barrier'|'tests',env?:NodeJS.ProcessEnv):Admission
export function assertIdentity(row:Identity,profile:Profile,creation:Record<string,unknown>):void
export function assertTestURLs(env:NodeJS.ProcessEnv,profile:Profile):void
export function assertNativeAdmission(client:Queryable,admission:Admission,allowedTags?:string[]):Promise<unknown>
export function waitForOwnedPoolDisconnect(observer:Queryable, applicationName:string):Promise<void>
export interface MigrationPin { name:string; sha256:string }
export interface MigrationEntry { name:string; isFile():boolean; isDirectory():boolean; isSymbolicLink():boolean }
export function assertJournal(actual:string[],expected:string[]):void
export function assertMigrationFiles(actual:MigrationEntry[],expected:MigrationPin[]):void
export function verifyMigrationDirectory(directory:string,expected:MigrationPin[]):string[]
export function fileSHA(path:string):string

export function profileMigrationCount(profile:Pick<Profile,'mode'>):83|133
export function reviewedMigrationPins(count:number):MigrationPin[]

export function verifySource(source:{kind:'c04_c05_current_source83_v1'|'c04_c05_current_source85_v1'|'c04_c05_current_source86_v1'|'c04_c05_current_source87_v1'|'c04_c05_current_source88_v1'|'c04_c05_current_source89_v1'|'c04_c05_current_source90_v1'|'c04_c05_current_source91_v1'|'c04_c05_current_source92_v1'|'c04_c05_current_source93_v1'|'c04_c05_current_source94_v1'|'c04_c05_current_source95_v1'|'c04_c05_current_source96_v1'|'c04_c05_current_source97_v1'|'c04_c05_current_source98_v1'|'c04_c05_current_source99_v1'|'c04_c05_current_source100_v1'|'c04_c05_current_source101_v1'|'c04_c05_current_source102_v1'|'c04_c05_current_source103_v1'|'c04_c05_current_source104_v1'|'c04_c05_current_source105_v1'|'c04_c05_current_source106_v1'|'c04_c05_current_source107_v1'|'c04_c05_current_source108_v1'|'c04_c05_current_source109_v1'|'c04_c05_current_source110_v1'|'c04_c05_current_source111_v1'|'c04_c05_current_source112_v1'|'c04_c05_current_source113_v1'|'c04_c05_current_source114_v1'|'c04_c05_current_source115_v1'|'c04_c05_current_source116_v1'|'c04_c05_current_source117_v1'|'c04_c05_current_source118_v1'|'c04_c05_current_source119_v1'|'c04_c05_current_source120_v1'|'c04_c05_current_source121_v1'|'c04_c05_current_source122_v1'|'c04_c05_current_source123_v1'|'c04_c05_current_source124_v1'|'c04_c05_current_source125_v1'|'c04_c05_current_source126_v1'|'c04_c05_current_source127_v1'|'c04_c05_current_source128_v1'|'c04_c05_current_source129_v1'|'c04_c05_current_source130_v1'|'c04_c05_current_source131_v1'|'c04_c05_current_source132_v1'|'c04_c05_current_source133_v1';backend:string;repo:string;files:{path:string;sha256:string}[]}):string[]

export const SCHEMA_CATALOG:string
