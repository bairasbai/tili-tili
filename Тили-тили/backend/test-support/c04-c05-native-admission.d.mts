import type { Queryable } from '../src/plugins/db.js'
export interface Profile { mode:'local'|'github-ci';targetName:string;targetURL:string;username:string;port:number;fixedOID?:string;context?:Record<string,string> }
export interface Identity {name:string;username:string;port:number;address:string;oid:string;pid:number}
export interface Admission {profile:Profile;creation:Record<string,unknown>;schema:{journalNames:string[];retainedAudits:unknown[];triggers:unknown[];migrationCount:number};source:unknown;sourceSHA256:string;directory:string;targetName:string;targetURL:string;oid:string;stage:string}
export function readAdmission(stage:'barrier'|'tests',env?:NodeJS.ProcessEnv):Admission
export function assertIdentity(row:Identity,profile:Profile,creation:Record<string,unknown>):void
export function assertTestURLs(env:NodeJS.ProcessEnv,profile:Profile):void
export function assertNativeAdmission(client:Queryable,admission:Admission,allowedTags?:string[]):Promise<unknown>
