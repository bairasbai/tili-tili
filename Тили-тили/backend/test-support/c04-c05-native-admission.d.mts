import type { Queryable } from '../src/plugins/db.js'
export interface Profile { mode:'local'|'github-ci';targetName:string;targetURL:string;username:string;port:number;fixedOID?:string;context?:Record<string,string> }
export interface Identity {name:string;username:string;port:number;address:string;oid:string;pid:number}
export interface Admission {profile:Profile;creation:Record<string,unknown>;schema:{journalNames:string[];retainedAudits:unknown[];triggers:unknown[];migrationCount:number};source:unknown;sourceSHA256:string;directory:string;targetName:string;targetURL:string;oid:string;stage:string}
export function readAdmission(stage:'barrier'|'tests',env?:NodeJS.ProcessEnv):Admission
export function assertIdentity(row:Identity,profile:Profile,creation:Record<string,unknown>):void
export function assertTestURLs(env:NodeJS.ProcessEnv,profile:Profile):void
export function assertNativeAdmission(client:Queryable,admission:Admission,allowedTags?:string[]):Promise<unknown>
export interface MigrationPin { name:string; sha256:string }
export interface MigrationEntry { name:string; isFile():boolean; isDirectory():boolean; isSymbolicLink():boolean }
export function assertJournal(actual:string[],expected:string[]):void
export function assertMigrationFiles(actual:MigrationEntry[],expected:MigrationPin[]):void
export function verifyMigrationDirectory(directory:string,expected:MigrationPin[]):string[]
export function fileSHA(path:string):string

export function profileMigrationCount(profile:Profile):83|85
export function reviewedMigrationPins(count:number):MigrationPin[]

export function verifySource(source:{kind:'c04_c05_current_source83_v1'|'c04_c05_current_source85_v1';backend:string;repo:string;files:{path:string;sha256:string}[]}):string[]
