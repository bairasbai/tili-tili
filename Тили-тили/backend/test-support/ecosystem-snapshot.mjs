// Shared verbatim catalogue/row capture from the preserving ecosystem drill.
// Callers provide their own mandatory native target/quiescence safety gate.
export async function snapshotPublic({ db, safety, rows }) {
  await safety()
  const tables = (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(row => row.tablename)
  const data = {}
  for (const table of tables) data[table] = await rows(table)
  const schema = {
    extensions: (await db.query(`select e.extname,e.extversion,pg_get_userbyid(e.extowner) as owner,n.nspname as schema,
      e.extrelocatable,e.extconfig,e.extcondition,obj_description(e.oid,'pg_extension') as comment
      from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by e.extname`)).rows,
    extensionMembers: (await db.query(`select e.extname,x.type,x.schema,x.name,x.identity from pg_depend d
      join pg_extension e on e.oid=d.refobjid cross join lateral pg_identify_object(d.classid,d.objid,d.objsubid) x
      where d.refclassid='pg_extension'::regclass and d.deptype='e' order by e.extname,x.type,x.schema,x.name,x.identity`)).rows,
    operatorClasses: (await db.query(`select c.opcname,a.amname,c.opcintype::regtype::text as input_type,c.opckeytype::regtype::text as key_type,
      c.opcdefault,f.opfname as family,pg_get_userbyid(c.opcowner) as owner,obj_description(c.oid,'pg_opclass') as comment
      from pg_opclass c join pg_namespace n on n.oid=c.opcnamespace join pg_am a on a.oid=c.opcmethod
      join pg_opfamily f on f.oid=c.opcfamily where n.nspname='public' order by c.opcname,a.amname`)).rows,
    operatorFamilies: (await db.query(`select f.opfname,a.amname,pg_get_userbyid(f.opfowner) as owner,obj_description(f.oid,'pg_opfamily') as comment,
      array(select concat_ws('|',o.amoplefttype::regtype::text,o.amoprighttype::regtype::text,o.amopstrategy,o.amoppurpose,o.amopopr::regoperator::text)
        from pg_amop o where o.amopfamily=f.oid order by o.amoplefttype::regtype::text,o.amoprighttype::regtype::text,o.amopstrategy,o.amoppurpose) as operators,
      array(select concat_ws('|',p.amproclefttype::regtype::text,p.amprocrighttype::regtype::text,p.amprocnum,p.amproc::regprocedure::text)
        from pg_amproc p where p.amprocfamily=f.oid order by p.amproclefttype::regtype::text,p.amprocrighttype::regtype::text,p.amprocnum) as procedures
      from pg_opfamily f join pg_namespace n on n.oid=f.opfnamespace join pg_am a on a.oid=f.opfmethod where n.nspname='public' order by f.opfname,a.amname`)).rows,
    operators: (await db.query(`select o.oprname,o.oprleft::regtype::text as left_type,o.oprright::regtype::text as right_type,
      o.oprresult::regtype::text as result_type,o.oprcode::regprocedure::text as procedure,pg_get_userbyid(o.oprowner) as owner,
      obj_description(o.oid,'pg_operator') as comment from pg_operator o join pg_namespace n on n.oid=o.oprnamespace
      where n.nspname='public' order by o.oprname,o.oprleft::regtype::text,o.oprright::regtype::text`)).rows,
    namespaces: (await db.query("select nspname,pg_get_userbyid(nspowner) as owner,nspacl,obj_description(oid,'pg_namespace') as comment from pg_namespace where nspname='public'")).rows,
    relations: (await db.query(`select c.relname,c.relkind,c.relpersistence,pg_get_userbyid(c.relowner) as owner,c.relacl,c.reloptions,c.relrowsecurity,c.relforcerowsecurity,c.relispartition,
      obj_description(c.oid,'pg_class') as comment,case when c.relkind in ('v','m') then pg_get_viewdef(c.oid,true) else null end as view_definition,
      pg_get_expr(c.relpartbound,c.oid,true) as partition_bound from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname`)).rows,
    columns: (await db.query("select * from information_schema.columns where table_schema='public' order by table_name,ordinal_position")).rows,
    columnMetadata: (await db.query(`select c.relname,a.attname,a.attacl,col_description(c.oid,a.attnum) as comment from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum`)).rows,
    constraints: (await db.query(`select c.relname as table_name,k.conname,k.contype,k.convalidated,k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid,true) as definition
      from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname,k.conname`)).rows,
    indexes: (await db.query("select tablename,indexname,indexdef from pg_indexes where schemaname='public' order by tablename,indexname")).rows,
    triggers: (await db.query(`select c.relname as table_name,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname`)).rows,
    functions: (await db.query(`select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,pg_get_functiondef(p.oid) as definition,pg_get_userbyid(p.proowner) as owner,p.proacl,obj_description(p.oid,'pg_proc') as comment from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind in ('f','p') order by p.proname,pg_get_function_identity_arguments(p.oid)`)).rows,
    types: (await db.query(`select t.typname,t.typtype,t.typcategory,t.typnotnull,t.typdefault,t.typdelim,t.typacl,pg_get_userbyid(t.typowner) as owner,
      format_type(t.typbasetype,t.typtypmod) as base_type,obj_description(t.oid,'pg_type') as comment,
      array(select e.enumlabel from pg_enum e where e.enumtypid=t.oid order by e.enumsortorder) as enum_labels
      from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' order by t.typname`)).rows,
    sequenceDefinitions: (await db.query(`select c.relname,format_type(s.seqtypid,null) as data_type,s.seqstart::text,s.seqincrement::text,s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle,
      target.relname as owned_table,a.attname as owned_column,d.deptype from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_namespace n on n.oid=c.relnamespace
      left join pg_depend d on d.objid=c.oid and d.classid='pg_class'::regclass and d.refclassid='pg_class'::regclass and d.deptype in ('a','i')
      left join pg_class target on target.oid=d.refobjid left join pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid
      where n.nspname='public' order by c.relname`)).rows,
  }
  // Runtime sequence last_value is deliberately excluded: PostgreSQL nextval
  // consumption is not rolled back. Definition, ownership, ACL and comments
  // are checked; this drill does not promise transactional counter restoration.
  return { data, schema }
}
