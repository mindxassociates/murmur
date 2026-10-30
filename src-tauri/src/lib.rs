use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use chrono::Utc;
use hmac::{Hmac, Mac};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use scrypt::{scrypt, Params as ScryptParams};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, io::Read as _, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Default)]
struct Runtime {
    db: Option<Connection>,
    db_key: Option<[u8; 32]>,
    user: Option<UserSession>,
    paths: Option<AppPaths>,
    failures: HashMap<String, (u32, i64)>,
}
struct AppState(Mutex<Runtime>);

#[derive(Clone)]
struct AppPaths { data: PathBuf, backups: PathBuf, db: PathBuf, access: PathBuf }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct UserSession { id:String, username:String, display_name:String, role:String }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct AuthStatus { needs_setup: bool, authenticated: bool, user: Option<UserSession> }
#[derive(Serialize)]
struct OpResult { ok: bool, #[serde(skip_serializing_if="Option::is_none")] error: Option<String>, #[serde(skip_serializing_if="Option::is_none")] user: Option<UserSession> }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct SetupInput { username:String, display_name:String, password:String }
#[derive(Deserialize)]
struct LoginInput { username:String, password:String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct ChangePasswordInput { current_password:String, new_password:String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct CreateUserInput { username:String, display_name:String, role:String, password:String }
#[derive(Deserialize)]
struct ActiveInput { id:String, active:bool }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct AuditEventInput { action:String, object_type:Option<String>, object_id:Option<String>, detail:Option<String> }
#[derive(Serialize, Deserialize, Default)]
struct AccessFile { version:u32, users:Vec<AccessUser> }
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all="camelCase")]
struct AccessUser { id:String, username:String, display_name:String, role:String, active:bool, salt:String, verifier:String, wrapped_key:WrappedKey }
#[derive(Serialize, Deserialize, Clone)]
struct WrappedKey { nonce:String, data:String }

fn now() -> String { Utc::now().to_rfc3339() }
fn now_ms() -> i64 { Utc::now().timestamp_millis() }
fn random32() -> [u8;32] { let mut b=[0u8;32]; rand::rng().fill_bytes(&mut b); b }
fn random16() -> [u8;16] { let mut b=[0u8;16]; rand::rng().fill_bytes(&mut b); b }
fn derive(password:&str, salt:&[u8]) -> Result<[u8;32],String> { let mut out=[0u8;32]; let p=ScryptParams::new(15,8,1,32).map_err(|e|e.to_string())?; scrypt(password.as_bytes(),salt,&p,&mut out).map_err(|e|e.to_string())?; Ok(out) }
fn verifier(password:&str,salt:&[u8])->Result<String,String>{let k=derive(password,salt)?;let mut mac=<HmacSha256 as Mac>::new_from_slice(&k).map_err(|e|e.to_string())?;mac.update(b"murmur-access-v1");Ok(hex::encode(mac.finalize().into_bytes()))}
fn wrap_key(db_key:&[u8;32],password:&str,salt:&[u8])->Result<WrappedKey,String>{let key=derive(password,salt)?;let cipher=Aes256Gcm::new_from_slice(&key).map_err(|e|e.to_string())?;let mut n=[0u8;12];rand::rng().fill_bytes(&mut n);let data=cipher.encrypt(Nonce::from_slice(&n),db_key.as_ref()).map_err(|_|"Could not protect the database key".to_string())?;Ok(WrappedKey{nonce:hex::encode(n),data:hex::encode(data)})}
fn unwrap_key(w:&WrappedKey,password:&str,salt:&[u8])->Result<[u8;32],String>{let key=derive(password,salt)?;let cipher=Aes256Gcm::new_from_slice(&key).map_err(|e|e.to_string())?;let n=hex::decode(&w.nonce).map_err(|_|"Credentials are corrupted".to_string())?;let data=hex::decode(&w.data).map_err(|_|"Credentials are corrupted".to_string())?;let plain=cipher.decrypt(Nonce::from_slice(&n),data.as_ref()).map_err(|_|"Incorrect username or password.".to_string())?;plain.try_into().map_err(|_|"Invalid database key length".to_string())}
fn password_hash(password:&str,salt:&[u8])->Result<String,String>{Ok(hex::encode(derive(password,salt)?))}
fn ct_eq_hex(a:&str,b:&str)->bool{match(hex::decode(a),hex::decode(b)){(Ok(x),Ok(y)) if x.len()==y.len()=>x.ct_eq(&y).into(),_=>false}}

fn portable_base(exe:&Path)->Option<PathBuf>{
    // A "portable.mode" marker file switches the app to portable mode:
    // all data lives in Data/ + Backups/ folders next to the marker.
    // Windows / loose binary: the marker sits beside the .exe.
    // macOS: the marker sits beside the .app bundle (the binary itself
    // lives in App.app/Contents/MacOS and the bundle must stay read-only
    // to keep its code signature valid).
    let exe_dir=exe.parent()?.to_path_buf();
    if exe_dir.join("portable.mode").exists(){return Some(exe_dir)}
    if exe_dir.ends_with("MacOS"){
        if let Some(folder)=exe_dir.parent().and_then(|c|c.parent()).and_then(|b|b.parent()){
            if folder.join("portable.mode").exists(){return Some(folder.to_path_buf())}
        }
    }
    None
}
fn make_paths(base:PathBuf)->Result<AppPaths,String>{
    let data=base.join("Data");let backups=base.join("Backups");
    fs::create_dir_all(&data).map_err(|e|e.to_string())?;fs::create_dir_all(&backups).map_err(|e|e.to_string())?;
    Ok(AppPaths{db:data.join("murmur.db"),access:data.join("access.json"),data,backups})
}
fn app_paths(app:&AppHandle)->Result<AppPaths,String>{
    let exe=std::env::current_exe().map_err(|e|e.to_string())?;
    let exe_dir=exe.parent().unwrap_or(Path::new(".")).to_path_buf();
    let portable=portable_base(&exe).or_else(||if std::env::var("MURMUR_PORTABLE").ok().as_deref()==Some("1"){Some(exe_dir.clone())}else{None});
    if let Some(base)=portable{
        // If the portable location turns out not to be writable
        // (e.g. a read-only USB stick), fall back to the standard
        // per-user data directory instead of failing to start.
        if let Ok(paths)=make_paths(base){return Ok(paths)}
    }
    let base=app.path().app_local_data_dir().map_err(|e|e.to_string())?;
    make_paths(base)
}
fn read_access(p:&Path)->AccessFile{fs::read_to_string(p).ok().and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(AccessFile{version:2,users:vec![]})}
fn write_access(p:&Path,a:&AccessFile)->Result<(),String>{let tmp=p.with_extension("json.tmp");fs::write(&tmp,serde_json::to_vec_pretty(a).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;fs::rename(tmp,p).map_err(|e|e.to_string())}
fn open_db(path:&Path,key:&[u8;32])->Result<Connection,String>{let c=Connection::open(path).map_err(|e|e.to_string())?;c.pragma_update(None,"key",format!("x'{}'",hex::encode(key))).map_err(|e|format!("Could not unlock the database: {e}"))?;c.query_row("SELECT count(*) FROM sqlite_master",[],|r|r.get::<_,i64>(0)).map_err(|_|"Invalid database password or file.".to_string())?;create_schema(&c)?;Ok(c)}
fn create_schema(c:&Connection)->Result<(),String>{c.execute_batch(r#"
PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,dob TEXT,gender TEXT,status TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,client_id TEXT,date TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS appointments(id TEXT PRIMARY KEY,client_id TEXT,date TEXT,time TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,client_id TEXT,status TEXT,due TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,client_id TEXT,date TEXT,status TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY,client_id TEXT,status TEXT,due TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quick_notes(id TEXT PRIMARY KEY,client_id TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_templates(id TEXT PRIMARY KEY,name TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS referrals(id TEXT PRIMARY KEY,name TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assessments(id TEXT PRIMARY KEY,client_id TEXT,date TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS waitlist(id TEXT PRIMARY KEY,name TEXT,status TEXT,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recent_views(id TEXT PRIMARY KEY,client_id TEXT,viewed_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS treatment_plans(client_id TEXT PRIMARY KEY,updated_at TEXT,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT NOT NULL,user_id TEXT,username TEXT,action TEXT NOT NULL,object_type TEXT,object_id TEXT,result TEXT NOT NULL,detail TEXT,prev_hash TEXT NOT NULL,entry_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
"#).map_err(|e|e.to_string())?;Ok(())}
fn require_user(rt:&Runtime)->Result<&UserSession,String>{rt.user.as_ref().ok_or_else(||"The app is locked. Please sign in again.".to_string())}
fn require_admin(rt:&Runtime)->Result<&UserSession,String>{let u=require_user(rt)?;if u.role!="Admin"{return Err("Only an administrator can do this.".into())}Ok(u)}
fn audit_key(rt:&Runtime)->Result<[u8;32],String>{let k=rt.db_key.ok_or("Database is not unlocked")?;let mut h=Sha256::new();h.update(b"audit-v2|");h.update(k);Ok(h.finalize().into())}
fn audit(rt:&Runtime,action:&str,typ:&str,id:&str,result:&str,detail:&str)->Result<(),String>{let db=rt.db.as_ref().ok_or("Database is not unlocked")?;let prev:String=db.query_row("SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?.unwrap_or_else(||"GENESIS".into());let ts=now();let (uid,un)=rt.user.as_ref().map(|u|(u.id.clone(),u.username.clone())).unwrap_or((String::new(),"System".into()));let payload=format!("{}|{}|{}|{}|{}|{}|{}|{}|{}",ts,uid,un,action,typ,id,result,detail,prev);let mut mac=<HmacSha256 as Mac>::new_from_slice(&audit_key(rt)?).map_err(|e|e.to_string())?;mac.update(payload.as_bytes());let hash=hex::encode(mac.finalize().into_bytes());db.execute("INSERT INTO audit_log(ts,user_id,username,action,object_type,object_id,result,detail,prev_hash,entry_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",params![ts,uid,un,action,typ,id,result,detail.chars().take(1000).collect::<String>(),prev,hash]).map_err(|e|e.to_string())?;Ok(())}
fn all_json(db:&Connection,table:&str)->Result<Vec<Value>,String>{let mut st=db.prepare(&format!("SELECT json FROM {table}")).map_err(|e|e.to_string())?;let rows=st.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;Ok(rows.filter_map(|x|x.ok()).filter_map(|x|serde_json::from_str(&x).ok()).collect())}
fn workspace(db:&Connection)->Result<Value,String>{let settings:String=db.query_row("SELECT json FROM settings WHERE id=1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?.unwrap_or("{}".into());Ok(json!({"clients":all_json(db,"clients")?,"sessions":all_json(db,"sessions")?,"events":all_json(db,"appointments")?,"tasks":all_json(db,"tasks")?,"finance":all_json(db,"payments")?,"goals":all_json(db,"goals")?,"quickNotes":all_json(db,"quick_notes")?,"templates":all_json(db,"session_templates")?,"referrals":all_json(db,"referrals")?,"assessments":all_json(db,"assessments")?,"waitlist":all_json(db,"waitlist")?,"recent":all_json(db,"recent_views")?,"settings":serde_json::from_str::<Value>(&settings).unwrap_or(json!({}))}))}
fn insert_json(tx:&rusqlite::Transaction<'_>,table:&str,o:&Value,extra:&[(&str,Value)])->Result<(),String>{let id=o.get("id").and_then(Value::as_str).unwrap_or("");let mut cols=vec!["id".to_string()];let mut vals=vec![Value::String(id.into())];for(k,v)in extra{cols.push((*k).into());vals.push(v.clone())}cols.push("updated_at".into());vals.push(Value::String(now()));cols.push("json".into());vals.push(Value::String(serde_json::to_string(o).map_err(|e|e.to_string())?));let sql=format!("INSERT INTO {table}({}) VALUES({})",cols.join(","),vec!["?";cols.len()].join(","));let params:Vec<rusqlite::types::Value>=vals.into_iter().map(|v|match v{Value::Null=>rusqlite::types::Value::Null,Value::String(s)=>rusqlite::types::Value::Text(s),_=>rusqlite::types::Value::Text(v.to_string())}).collect();tx.execute(&sql,rusqlite::params_from_iter(params)).map_err(|e|e.to_string())?;Ok(())}
fn replace_workspace(db:&mut Connection,x:&Value)->Result<(),String>{let tx=db.transaction().map_err(|e|e.to_string())?;tx.execute_batch("DELETE FROM sessions;DELETE FROM appointments;DELETE FROM tasks;DELETE FROM payments;DELETE FROM goals;DELETE FROM quick_notes;DELETE FROM session_templates;DELETE FROM referrals;DELETE FROM assessments;DELETE FROM waitlist;DELETE FROM recent_views;DELETE FROM treatment_plans;DELETE FROM clients;DELETE FROM settings;").map_err(|e|e.to_string())?;for o in x["clients"].as_array().unwrap_or(&vec![]){insert_json(&tx,"clients",o,&[("name",o["name"].clone()),("dob",o["dob"].clone()),("gender",o["gender"].clone()),("status",o["status"].clone())])?;if let Some(plan)=o.get("plan"){if plan.as_object().map(|x|!x.is_empty()).unwrap_or(false){tx.execute("INSERT INTO treatment_plans(client_id,updated_at,json) VALUES(?,?,?)",params![o["id"].as_str().unwrap_or(""),now(),plan.to_string()]).map_err(|e|e.to_string())?;}}}for(key,table,extras)in[("sessions","sessions",vec!["client_id","date"]),("events","appointments",vec!["client_id","date","time"]),("tasks","tasks",vec!["client_id","status","due"]),("finance","payments",vec!["client_id","date","status"]),("goals","goals",vec!["client_id","status","due"]),("quickNotes","quick_notes",vec!["client_id"]),("templates","session_templates",vec!["name"]),("referrals","referrals",vec!["name"]),("assessments","assessments",vec!["client_id","date"]),("waitlist","waitlist",vec!["name","status"]),("recent","recent_views",vec!["client_id","viewed_at"]) ]{if let Some(a)=x[key].as_array(){for o in a{let ex:Vec<(&str,Value)>=extras.iter().map(|k|{let js=match *k{"client_id"=>o.get("clientId").cloned().filter(|v|v.as_str().map(|s|!s.is_empty()).unwrap_or(false)).unwrap_or(Value::Null),"viewed_at"=>o.get("time").cloned().unwrap_or(Value::Null),_=>o.get(k.trim_end_matches("_id")).cloned().or_else(||o.get(*k).cloned()).unwrap_or(Value::Null)};(*k,js)}).collect();insert_json(&tx,table,o,&ex)?}}}tx.execute("INSERT INTO settings(id,json,updated_at) VALUES(1,?,?)",params![x.get("settings").unwrap_or(&json!({})).to_string(),now()]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())}


fn daily_auto_backup(p:&AppPaths,db:&Connection,key:&[u8;32]){
    // Once per calendar day (UTC date in the file name), keep the newest 30 auto backups.
    let today=Utc::now().with_timezone(&chrono::FixedOffset::east_opt(8*3600).unwrap()).format("%Y-%m-%d").to_string();
    let file=p.backups.join(format!("notes_{today}_auto.db"));
    if file.exists(){return}
    if db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").is_err(){return}
    if fs::copy(&p.db,&file).is_err(){return}
    let verified=open_db(&file,key).and_then(|chk|chk.query_row("PRAGMA integrity_check",[],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())).map(|s|s.eq_ignore_ascii_case("ok")).unwrap_or(false);
    if !verified{let _=fs::remove_file(&file);return}
    if let Ok(rd)=fs::read_dir(&p.backups){
        let mut autos:Vec<PathBuf>=rd.filter_map(|e|e.ok()).map(|e|e.path()).filter(|x|x.file_name().and_then(|n|n.to_str()).map(|n|n.starts_with("notes_")&&n.ends_with("_auto.db")).unwrap_or(false)).collect();
        autos.sort();
        while autos.len()>30{let old=autos.remove(0);let _=fs::remove_file(old);}
    }
}
#[tauri::command] fn startup_status(app:AppHandle,state:State<AppState>)->Result<AuthStatus,String>{let mut rt=state.0.lock().unwrap();let p=app_paths(&app)?;let a=read_access(&p.access);let needs=!p.db.exists()||fs::metadata(&p.db).map(|m|m.len()==0).unwrap_or(true)||a.users.is_empty();rt.paths=Some(p);Ok(AuthStatus{needs_setup:needs,authenticated:false,user:None})}
#[tauri::command] fn startup_setup(app:AppHandle,state:State<AppState>,input:SetupInput)->Result<OpResult,String>{if input.username.trim().len()<2||input.password.len()<10{return Ok(OpResult{ok:false,error:Some("Username must be at least 2 characters; password at least 10 characters.".into()),user:None})}let p=app_paths(&app)?;if p.db.exists()&&fs::metadata(&p.db).map(|m|m.len()>0).unwrap_or(false){return Ok(OpResult{ok:false,error:Some("An existing database was found and will not be overwritten.".into()),user:None})}let key=random32();let db=open_db(&p.db,&key)?;let salt=random16();let id=Uuid::new_v4().to_string();let ph=password_hash(&input.password,&salt)?;db.execute("INSERT INTO users(id,username,display_name,password_hash,salt,role,active,created_at,updated_at) VALUES(?,?,?,?,?,'Admin',1,?,?)",params![id,input.username.trim(),if input.display_name.trim().is_empty(){input.username.trim()}else{input.display_name.trim()},ph,hex::encode(salt),now(),now()]).map_err(|e|e.to_string())?;let user=UserSession{id:id.clone(),username:input.username.trim().into(),display_name:if input.display_name.trim().is_empty(){input.username.trim().into()}else{input.display_name.trim().into()},role:"Admin".into()};let au=AccessUser{id:id.clone(),username:user.username.clone(),display_name:user.display_name.clone(),role:user.role.clone(),active:true,salt:hex::encode(salt),verifier:verifier(&input.password,&salt)?,wrapped_key:wrap_key(&key,&input.password,&salt)?};write_access(&p.access,&AccessFile{version:2,users:vec![au]})?;let mut rt=state.0.lock().unwrap();rt.db=Some(db);rt.db_key=Some(key);rt.user=Some(user.clone());rt.paths=Some(p);audit(&rt,"Create user","User",&id,"Success","Initial administrator account")?;Ok(OpResult{ok:true,error:None,user:Some(user)})}
#[tauri::command] fn startup_login(app:AppHandle,state:State<AppState>,input:LoginInput)->Result<OpResult,String>{let p=app_paths(&app)?;let a=read_access(&p.access);let mut rt=state.0.lock().unwrap();let f=rt.failures.get(&input.username).cloned().unwrap_or((0,0));if now_ms()<f.1{return Ok(OpResult{ok:false,error:Some("Too many sign-in attempts. Please try again later.".into()),user:None})}let au=match a.users.iter().find(|u|u.username==input.username&&u.active){Some(x)=>x.clone(),None=>return Ok(OpResult{ok:false,error:Some("Incorrect username or password.".into()),user:None})};let salt=hex::decode(&au.salt).map_err(|_|"Access credentials are corrupted".to_string())?;if !ct_eq_hex(&verifier(&input.password,&salt)?,&au.verifier){let n=f.0+1;rt.failures.insert(input.username.clone(),if n>=5{(0,now_ms()+300000)}else{(n,0)});return Ok(OpResult{ok:false,error:Some("Incorrect username or password.".into()),user:None})}let key=unwrap_key(&au.wrapped_key,&input.password,&salt)?;let db=open_db(&p.db,&key)?;let row:(String,String,String,String,i64,String)=db.query_row("SELECT id,username,display_name,role,active,password_hash FROM users WHERE id=?",[&au.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(|_|"Account verification failed.".to_string())?;if row.4!=1||!ct_eq_hex(&password_hash(&input.password,&salt)?,&row.5){return Ok(OpResult{ok:false,error:Some("Account verification failed.".into()),user:None})}let user=UserSession{id:row.0,username:row.1,display_name:row.2,role:row.3};rt.db=Some(db);rt.db_key=Some(key);rt.user=Some(user.clone());rt.paths=Some(p);rt.failures.remove(&input.username);if let (Some(paths),Some(db),Some(key))=(rt.paths.clone(),rt.db.as_ref(),rt.db_key){daily_auto_backup(&paths,db,&key)}audit(&rt,"Sign in","User",&user.id,"Success",&if f.0>0{format!("{} failed sign-in attempt(s) since the last successful sign-in",f.0)}else{String::new()})?;Ok(OpResult{ok:true,error:None,user:Some(user)})}
#[tauri::command] fn auth_status(state:State<AppState>)->Result<AuthStatus,String>{let rt=state.0.lock().unwrap();Ok(AuthStatus{needs_setup:false,authenticated:rt.user.is_some(),user:rt.user.clone()})}
#[tauri::command] fn auth_lock(state:State<AppState>)->Result<Value,String>{let mut rt=state.0.lock().unwrap();if rt.user.is_some(){audit(&rt,"Lock app","Security","","Success","")?}rt.user=None;rt.db=None;rt.db_key=None;Ok(json!({"ok":true}))}
#[tauri::command] fn db_get_state(state:State<AppState>)->Result<String,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;Ok(workspace(rt.db.as_ref().unwrap())?.to_string())}
#[tauri::command] fn db_set_state(state:State<AppState>,json:String)->Result<bool,String>{let x:Value=serde_json::from_str(&json).map_err(|_|"Invalid data format".to_string())?;if !x.is_object()||!x["clients"].is_array()||!x["sessions"].is_array()||!x["events"].is_array(){return Err("Incomplete data - write refused (protects against accidental wiping)".into())}let mut rt=state.0.lock().unwrap();require_user(&rt)?;let old=workspace(rt.db.as_ref().unwrap())?;replace_workspace(rt.db.as_mut().unwrap(),&x)?;if old!=x{audit(&rt,"Save changes","Workspace","","Success","Workspace data updated")?}Ok(true)}
#[tauri::command] fn db_list_prefs(state:State<AppState>)->Result<Value,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;let mut st=rt.db.as_ref().unwrap().prepare("SELECT key,value FROM preferences").map_err(|e|e.to_string())?;let rows=st.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;let mut map=serde_json::Map::new();for row in rows{let (k,v)=row.map_err(|e|e.to_string())?;map.insert(k,Value::String(v));}Ok(Value::Object(map))}

// ---------- Offline AI: Whisper transcription + local LLM note generation ----------
struct AiState(Mutex<AiRuntime>);
#[derive(Default)]
struct AiRuntime { download: Option<Arc<Mutex<DownloadShared>>>, proc: Option<Arc<Mutex<ProcShared>>>, audio: HashMap<String, PathBuf> }
#[derive(Default, Clone)]
struct DownloadShared { label: String, received: u64, total: u64, done: bool, cancelled: bool, error: Option<String> }
#[derive(Default)]
struct ProcShared { kind: String, progress: i32, output: String, stderr_tail: String, done: bool, error: Option<String>, child: Option<std::process::Child> }

const WHISPER_MODELS: [(&str, &str, &str); 4] = [
    ("base", "Base (fastest, lower accuracy)", "ggml-base.bin"),
    ("small", "Small (balanced)", "ggml-small.bin"),
    ("medium", "Medium (accurate, slower)", "ggml-medium.bin"),
    ("turbo", "Large v3 Turbo (most accurate, slowest)", "ggml-large-v3-turbo.bin"),
];
const LLM_MODELS: [(&str, &str, &str, &str); 2] = [
    ("qwen15", "Qwen2.5 1.5B (fast)", "qwen2.5-1.5b-instruct-q4_k_m.gguf", "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"),
    ("qwen3", "Qwen2.5 3B (recommended, better quality)", "qwen2.5-3b-instruct-q4_k_m.gguf", "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"),
];

const DIARIZE_MODELS: [(&str, &str, &str, &str); 2] = [
    ("seg", "Speaker segmentation model", "diarize-segmentation.onnx", "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx"),
    ("emb", "Speaker embedding model", "diarize-embedding.onnx", "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"),
];

fn ai_dirs(state: &State<AppState>) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let rt = state.0.lock().unwrap();
    require_user(&rt)?;
    let data = rt.paths.as_ref().ok_or("Data directory unavailable")?.data.clone();
    let models = data.join("ai-models");
    let engines = data.join("ai-engines");
    let audio = data.join("ai-audio");
    for d in [&models, &engines, &audio] { fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    Ok((models, engines, audio))
}
fn pref_value(state: &State<AppState>, key: &str) -> Option<String> {
    let rt = state.0.lock().unwrap();
    rt.db.as_ref()?.query_row("SELECT value FROM preferences WHERE key=?", [key], |r| r.get::<_, String>(0)).optional().ok().flatten().filter(|s| !s.is_empty())
}
fn find_exe(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    if !dir.exists() { return None; }
    // Strict candidate priority: exhaust the whole tree for names[0] before
    // trying names[1], so a preferred binary always wins over a fallback that
    // merely happens to sit closer to the root of the folder.
    for name in names {
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            if let Ok(rd) = fs::read_dir(&d) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() { stack.push(p); } else if p.file_name().and_then(|x| x.to_str()) == Some(name) { return Some(p); }
                }
            }
        }
    }
    None
}
fn resolve_engine(state: &State<AppState>, engines: &Path, which: &str) -> Option<PathBuf> {
    let (pref_key, names): (&str, &[&str]) = if which == "whisper" {
        ("aiWhisperPath", if cfg!(windows) { &["whisper-cli.exe"] } else if cfg!(target_os = "android") { &["libwhisper-cli.so", "whisper-cli"] } else { &["whisper-cli"] })
    } else if which == "diarize" {
        ("aiDiarizePath", if cfg!(windows) { &["sherpa-onnx-offline-speaker-diarization.exe"] } else { &["sherpa-onnx-offline-speaker-diarization"] })
    } else {
        ("aiLlamaPath", if cfg!(windows) { &["llama-cli.exe"] } else if cfg!(target_os = "android") { &["libllama-cli.so", "llama-cli"] } else { &["llama-cli"] })
    };
    if let Some(p) = pref_value(state, pref_key) { let pb = PathBuf::from(p); if pb.exists() { return Some(pb); } }
    if let Some(p) = find_exe(&engines.join(which), names) { return Some(p); }
    // Android: packaged engine executables live in the app's native library
    // directory (installed from jniLibs as lib*.so — the only location Android
    // allows executing binaries from). Files in the app-data engines folder
    // are found by the scan above, but Android 10+ may refuse to execute
    // them; the bundled copies below are the supported path.
    #[cfg(target_os = "android")]
    {
        if let Some(dir) = android_native_lib_dir() {
            let p = dir.join(names[0]);
            if p.exists() { return Some(p); }
        }
    }
    let mut candidates: Vec<PathBuf> = vec![];
    if cfg!(target_os = "macos") { candidates.push(PathBuf::from("/opt/homebrew/bin").join(names[0])); candidates.push(PathBuf::from("/usr/local/bin").join(names[0])); }
    if let Ok(path_var) = std::env::var("PATH") { for part in path_var.split(if cfg!(windows) { ';' } else { ':' }) { if !part.is_empty() { candidates.push(PathBuf::from(part).join(names[0])); } } }
    candidates.into_iter().find(|p| p.exists())
}
#[cfg(target_os = "android")]
fn android_native_lib_dir() -> Option<PathBuf> {
    // Derive the app's nativeLibraryDir from our own loaded library mapping.
    let maps = fs::read_to_string("/proc/self/maps").ok()?;
    for line in maps.lines() {
        if let Some(start) = line.find('/') {
            let path = line[start..].trim();
            if path.ends_with("libmurmur_lib.so") {
                if let Some(parent) = PathBuf::from(path).parent() { return Some(parent.to_path_buf()); }
            }
        }
    }
    None
}

fn model_file(models: &Path, kind: &str, id: &str) -> Option<(String, PathBuf)> {
    if kind == "whisper" { WHISPER_MODELS.iter().find(|m| m.0 == id).map(|m| (m.2.to_string(), models.join(m.2))) }
    else if kind == "diarize" { DIARIZE_MODELS.iter().find(|m| m.0 == id).map(|m| (m.2.to_string(), models.join(m.2))) }
    else { LLM_MODELS.iter().find(|m| m.0 == id).map(|m| (m.2.to_string(), models.join(m.2))) }
}
fn engine_download_url(which: &str) -> Option<String> {
    let os = std::env::consts::OS; let arch = std::env::consts::ARCH;
    match (which, os) {
        ("whisper", "windows") => Some("https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-x64.zip".into()),
        ("llama", "windows") => Some("https://github.com/ggml-org/llama.cpp/releases/download/b6123/llama-b6123-bin-win-cpu-x64.zip".into()),
        ("llama", "macos") => Some(format!("https://github.com/ggml-org/llama.cpp/releases/download/b6123/llama-b6123-bin-macos-{}.zip", if arch == "aarch64" { "arm64" } else { "x64" })),
        ("diarize", "windows") => Some("https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-no-tts.tar.bz2".into()),
        ("diarize", "macos") => Some(format!("https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-osx-{}-shared-no-tts.tar.bz2", if arch == "aarch64" { "arm64" } else { "x64" })),
        _ => None,
    }
}

fn tar_entry_path(dir: &Path, name: &str) -> Option<PathBuf> {
    let mut out = dir.to_path_buf();
    for part in name.split('/') {
        if part.is_empty() || part == "." { continue; }
        if part == ".." { return None; }
        out.push(part);
    }
    if out == dir { None } else { Some(out) }
}
// Minimal ustar reader for engine packages published as .tar.bz2 (the
// speaker-separation engine ships only in that form). Handles the base,
// ustar-prefix and GNU longname cases those archives use; link entries are
// recreated as copies of their target file so no symlink privilege is
// needed on Windows.
fn extract_tar_bytes(data: &[u8], dir: &Path) -> Result<(), String> {
    fn parse_octal(b: &[u8]) -> u64 { let mut v: u64 = 0; for &c in b { match c { b'0'..=b'7' => v = v * 8 + (c - b'0') as u64, 0 | b' ' => { if v > 0 { break; } }, _ => break } } v }
    fn field(b: &[u8]) -> String { let end = b.iter().position(|&c| c == 0).unwrap_or(b.len()); String::from_utf8_lossy(&b[..end]).to_string() }
    let mut pos = 0usize;
    let mut long_name: Option<String> = None;
    let mut links: Vec<(PathBuf, String)> = vec![];
    while pos + 512 <= data.len() {
        let h = &data[pos..pos + 512];
        if h.iter().all(|&c| c == 0) { break; }
        let size = parse_octal(&h[124..136]) as usize;
        let typeflag = h[156];
        let body_start = pos + 512;
        let body_end = body_start.saturating_add(size).min(data.len());
        match typeflag {
            b'L' => { long_name = Some(field(&data[body_start..body_end])); }
            b'x' | b'g' => {}
            _ => {
                let mut name = field(&h[0..100]);
                if &h[257..262] == b"ustar" { let prefix = field(&h[345..500]); if !prefix.is_empty() { name = format!("{}/{}", prefix, name); } }
                if let Some(l) = long_name.take() { if !l.is_empty() { name = l; } }
                if let Some(out) = tar_entry_path(dir, &name) {
                    if typeflag == b'5' { fs::create_dir_all(&out).map_err(|e| e.to_string())?; }
                    else if typeflag == b'1' || typeflag == b'2' { links.push((out, field(&h[157..257]))); }
                    else { if let Some(parent) = out.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; } fs::write(&out, &data[body_start..body_end]).map_err(|e| e.to_string())?; }
                }
            }
        }
        pos = body_start + (size + 511) / 512 * 512;
    }
    for (out, target) in links {
        let cand = out.parent().map(|p| p.join(&target)).filter(|p| p.exists()).or_else(|| tar_entry_path(dir, &target).filter(|p| p.exists()));
        if let Some(srcp) = cand { if !out.exists() { if let Some(parent) = out.parent() { let _ = fs::create_dir_all(parent); } let _ = fs::copy(&srcp, &out); } }
    }
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let mut stack = vec![dir.to_path_buf()]; while let Some(d) = stack.pop() { if let Ok(rd) = fs::read_dir(&d) { for e in rd.flatten() { let p = e.path(); if p.is_dir() { stack.push(p); } else { let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o755)); } } } } }
    Ok(())
}
fn extract_tar_bz2(src: &Path, dir: &Path) -> Result<(), String> {
    use std::io::Read as _;
    let f = fs::File::open(src).map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    bzip2::read::BzDecoder::new(f).read_to_end(&mut data).map_err(|e| format!("Extraction failed: {}", e))?;
    extract_tar_bytes(&data, dir).map_err(|e| format!("Extraction failed: {}", e))
}

#[tauri::command]
fn ai_status(state: State<AppState>, ai: State<AiState>) -> Result<Value, String> {
    let (models, engines, _audio) = ai_dirs(&state)?;
    let whisper = resolve_engine(&state, &engines, "whisper");
    let llama = resolve_engine(&state, &engines, "llama");
    let diarize = resolve_engine(&state, &engines, "diarize");
    let mut model_list: Vec<Value> = vec![];
    for (id, label, file) in WHISPER_MODELS { let p = models.join(file); model_list.push(json!({"id": id, "kind": "whisper", "label": label, "file": file, "downloaded": p.exists(), "bytes": p.metadata().map(|m| m.len()).unwrap_or(0)})); }
    for (id, label, file, _url) in LLM_MODELS { let p = models.join(file); model_list.push(json!({"id": id, "kind": "llm", "label": label, "file": file, "downloaded": p.exists(), "bytes": p.metadata().map(|m| m.len()).unwrap_or(0)})); }
    for (id, label, file, _url) in DIARIZE_MODELS { let p = models.join(file); model_list.push(json!({"id": id, "kind": "diarize", "label": label, "file": file, "downloaded": p.exists(), "bytes": p.metadata().map(|m| m.len()).unwrap_or(0)})); }
    if let Ok(rd) = fs::read_dir(&models) { for e in rd.flatten() { let n = e.file_name().to_string_lossy().to_string(); let known = WHISPER_MODELS.iter().any(|m| m.2 == n) || LLM_MODELS.iter().any(|m| m.2 == n) || DIARIZE_MODELS.iter().any(|m| m.2 == n); if !known && (n.ends_with(".bin") || n.ends_with(".gguf")) { model_list.push(json!({"id": format!("custom:{}", n), "kind": if n.ends_with(".bin") { "whisper" } else { "llm" }, "label": format!("Custom model {}", n), "file": n, "downloaded": true, "bytes": e.metadata().map(|m| m.len()).unwrap_or(0)})); } } }
    let rt = ai.0.lock().unwrap();
    let download = rt.download.as_ref().map(|d| { let s = d.lock().unwrap(); json!({"label": s.label, "received": s.received, "total": s.total, "done": s.done, "error": s.error}) });
    let proc = rt.proc.as_ref().map(|p| { let s = p.lock().unwrap(); json!({"kind": s.kind, "done": s.done}) });
    Ok(json!({"whisper": {"found": whisper.is_some(), "path": whisper.map(|p| p.to_string_lossy().to_string())}, "llama": {"found": llama.is_some(), "path": llama.map(|p| p.to_string_lossy().to_string())}, "diarize": {"found": diarize.is_some(), "path": diarize.map(|p| p.to_string_lossy().to_string())}, "models": model_list, "modelsDir": models.to_string_lossy(), "enginesDir": engines.to_string_lossy(), "os": std::env::consts::OS, "download": download, "proc": proc}))
}

#[tauri::command]
fn ai_download(state: State<AppState>, ai: State<AiState>, what: String) -> Result<bool, String> {
    let (models, engines, _a) = ai_dirs(&state)?;
    let (url, dest, extract_to, label): (String, PathBuf, Option<PathBuf>, String) = if let Some(w) = what.strip_prefix("engine-") {
        let url = engine_download_url(w).ok_or(if cfg!(target_os = "android") { "Engines are bundled with the Android app and cannot be downloaded. Reinstall or update the app to change engines." } else { "No automatic engine package for this system. Set a custom engine path (on macOS, whisper-cpp / llama.cpp can be installed via Homebrew)." })?;
        (url.clone(), engines.join(format!("{}-engine.{}", w, if url.ends_with(".tar.bz2") { "tar.bz2" } else { "zip" })), Some(engines.join(w)), format!("{} engine", w))
    } else if let Some(id) = what.strip_prefix("whisper-") {
        let (_f, p) = model_file(&models, "whisper", id).ok_or("Unknown model")?;
        (format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}", p.file_name().unwrap().to_string_lossy()), p, None, format!("Whisper {} model", id))
    } else if let Some(id) = what.strip_prefix("diarize-") {
        let m = DIARIZE_MODELS.iter().find(|m| m.0 == id).ok_or("Unknown model")?;
        (m.3.to_string(), models.join(m.2), None, format!("Speaker {} model", id))
    } else if let Some(id) = what.strip_prefix("llm-") {
        let m = LLM_MODELS.iter().find(|m| m.0 == id).ok_or("Unknown model")?;
        (m.3.to_string(), models.join(m.2), None, format!("Note {} model", id))
    } else { return Err("Unknown download item".into()); };
    let shared = Arc::new(Mutex::new(DownloadShared { label, ..Default::default() }));
    { let mut rt = ai.0.lock().unwrap(); if let Some(d) = &rt.download { if !d.lock().unwrap().done { return Err("A download is already in progress".into()); } } rt.download = Some(shared.clone()); }
    std::thread::spawn(move || {
        let fail = |shared: &Arc<Mutex<DownloadShared>>, msg: String| { let mut s = shared.lock().unwrap(); s.error = Some(msg); s.done = true; };
fn ai_http_agent() -> ureq::Agent {
    // Downloads verify certificates against the OS trust store (native TLS), so
    // institutional CAs / security software on user machines keep working, and
    // honor proxy environment variables when present.
    let mut builder = ureq::AgentBuilder::new();
    if let Ok(connector) = native_tls::TlsConnector::new() { builder = builder.tls_connector(std::sync::Arc::new(connector)); }
    let proxy_url = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"].iter().find_map(|k| std::env::var(k).ok()).filter(|v| !v.is_empty());
    if let Some(u) = proxy_url { if let Ok(proxy) = ureq::Proxy::new(&u) { builder = builder.proxy(proxy); } }
    builder.build()
}
        let agent = ai_http_agent();
        let resp = match agent.get(&url).call() { Ok(r) => r, Err(e) => { fail(&shared, format!("Download failed: {}", e)); return; } };
        let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
        { let mut s = shared.lock().unwrap(); s.total = total; }
        let mut reader = resp.into_reader();
        let mut file = match fs::File::create(&dest) { Ok(f) => f, Err(e) => { fail(&shared, e.to_string()); return; } };
        let mut buf = vec![0u8; 65536]; let mut received: u64 = 0;
        loop {
            if shared.lock().unwrap().cancelled { drop(file); let _ = fs::remove_file(&dest); fail(&shared, "Cancelled".into()); return; }
            match reader.read(&mut buf) { Ok(0) => break, Ok(n) => { use std::io::Write as _; if file.write_all(&buf[..n]).is_err() { fail(&shared, "Write failed".into()); return; } received += n as u64; shared.lock().unwrap().received = received; }, Err(e) => { fail(&shared, format!("Download interrupted: {}", e)); return; } }
        }
        drop(file);
        if let Some(dir) = extract_to {
            if dest.to_string_lossy().ends_with(".tar.bz2") {
                if let Err(e) = extract_tar_bz2(&dest, &dir) { fail(&shared, e); return; }
                let _ = fs::remove_file(&dest);
            } else {
            let f = match fs::File::open(&dest) { Ok(f) => f, Err(e) => { fail(&shared, e.to_string()); return; } };
            let mut zip = match zip::ZipArchive::new(f) { Ok(z) => z, Err(e) => { fail(&shared, format!("Extraction failed: {}", e)); return; } };
            if let Err(e) = zip.extract(&dir) { fail(&shared, format!("Extraction failed: {}", e)); return; }
            let _ = fs::remove_file(&dest);
            #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let mut stack = vec![dir.clone()]; while let Some(d) = stack.pop() { if let Ok(rd) = fs::read_dir(&d) { for e in rd.flatten() { let p = e.path(); if p.is_dir() { stack.push(p); } else { let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o755)); } } } } }
            }
        }
        let mut s = shared.lock().unwrap(); s.done = true;
    });
    Ok(true)
}
#[tauri::command]
fn ai_download_cancel(ai: State<AiState>) -> Result<bool, String> { let rt = ai.0.lock().unwrap(); if let Some(d) = &rt.download { d.lock().unwrap().cancelled = true; } Ok(true) }
#[tauri::command]
fn ai_set_engine_path(state: State<AppState>, which: String, path: String) -> Result<bool, String> {
    let key = if which == "whisper" { "aiWhisperPath" } else if which == "diarize" { "aiDiarizePath" } else { "aiLlamaPath" };
    let rt = state.0.lock().unwrap(); require_user(&rt)?;
    rt.db.as_ref().unwrap().execute("INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, path]).map_err(|e| e.to_string())?; Ok(true)
}
#[tauri::command]
fn ai_import_model(state: State<AppState>, kind: String, src: String) -> Result<String, String> {
    let (models, _e, _a) = ai_dirs(&state)?;
    let srcp = PathBuf::from(&src); let name = srcp.file_name().ok_or("Invalid path")?.to_string_lossy().to_string();
    if kind == "whisper" && !name.ends_with(".bin") { return Err("Whisper model must be a .bin file".into()); }
    if kind == "llm" && !name.ends_with(".gguf") { return Err("Note model must be a .gguf file".into()); }
    if kind == "diarize" && !name.ends_with(".onnx") { return Err("Speaker model must be a .onnx file".into()); }
    fs::copy(&srcp, models.join(&name)).map_err(|e| e.to_string())?; Ok(name)
}
#[tauri::command]
fn audio_begin(state: State<AppState>, ai: State<AiState>) -> Result<Value, String> {
    let (_m, _e, audio) = ai_dirs(&state)?;
    let id = Uuid::new_v4().to_string(); let path = audio.join(format!("{}.wav", id));
    fs::write(&path, []).map_err(|e| e.to_string())?;
    ai.0.lock().unwrap().audio.insert(id.clone(), path.clone());
    Ok(json!({"id": id, "path": path.to_string_lossy()}))
}
#[tauri::command]
fn audio_append(ai: State<AiState>, id: String, data: String) -> Result<bool, String> {
    use base64::Engine as _;
    let path = { let rt = ai.0.lock().unwrap(); rt.audio.get(&id).cloned().ok_or("Recording session not found")? };
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new().append(true).open(&path).map_err(|e| e.to_string())?;
    use std::io::Write as _; f.write_all(&bytes).map_err(|e| e.to_string())?; Ok(true)
}
#[tauri::command]
fn audio_finish(ai: State<AiState>, id: String) -> Result<Value, String> {
    let rt = ai.0.lock().unwrap(); let path = rt.audio.get(&id).cloned().ok_or("Recording session not found")?;
    Ok(json!({"path": path.to_string_lossy(), "bytes": path.metadata().map(|m| m.len()).unwrap_or(0)}))
}
// Build a finalized copy of an in-progress recording. While recording, the
// live file starts as one complete WAV (header + first audio) and then grows
// by raw PCM appends, so its RIFF and data-chunk size fields understate the
// true length. The copy keeps every audio byte but patches those two fields
// to the actual sizes, yielding a valid standalone WAV; the input bytes (and
// the live file they came from) are never modified. Pure function of the
// bytes so it can be exercised standalone in tests.
fn finalize_wav_copy(wav: &[u8]) -> Result<Vec<u8>, String> {
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" { return Err("Not a WAV recording".into()); }
    // The data chunk is the final chunk in the recordings this app writes;
    // everything from its payload start to EOF is audio, whatever the
    // (stale) declared size says.
    let mut pos = 12usize;
    let data_start = loop {
        if pos + 8 > wav.len() { return Err("WAV has no audio data".into()); }
        if &wav[pos..pos + 4] == b"data" { break pos + 8; }
        let size = u32::from_le_bytes([wav[pos + 4], wav[pos + 5], wav[pos + 6], wav[pos + 7]]) as usize;
        pos += 8 + size + (size % 2);
    };
    let mut actual = wav.len() - data_start;
    actual -= actual % 2; // 16-bit samples: drop a trailing half-sample byte
    if actual == 0 { return Err("The recording has no audio yet".into()); }
    let mut out = wav[..data_start + actual].to_vec();
    let riff_size = (out.len() - 8) as u32;
    out[4..8].copy_from_slice(&riff_size.to_le_bytes());
    let size_field = data_start - 4;
    out[size_field..size_field + 4].copy_from_slice(&(actual as u32).to_le_bytes());
    Ok(out)
}
#[tauri::command]
fn audio_snapshot(ai: State<AiState>, id: String) -> Result<Value, String> {
    let path = { let rt = ai.0.lock().unwrap(); rt.audio.get(&id).cloned().ok_or("Recording session not found")? };
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    let fixed = finalize_wav_copy(&data)?;
    let bytes = fixed.len();
    let snap = path.with_file_name(format!("{}-snap.wav", id));
    fs::write(&snap, &fixed).map_err(|e| e.to_string())?;
    Ok(json!({"path": snap.to_string_lossy(), "bytes": bytes}))
}
#[tauri::command]
fn secure_delete_file(p: &Path) {
    // Overwrite the file's bytes with zeros before unlinking, so a deleted
    // recording is not trivially recoverable from the raw disk.
    if let Ok(md) = fs::metadata(p) {
        let len = md.len();
        if len > 0 {
            if let Ok(mut f) = fs::OpenOptions::new().write(true).open(p) {
                use std::io::{Seek, SeekFrom, Write};
                let zeros = vec![0u8; 65536];
                let mut left = len;
                let _ = f.seek(SeekFrom::Start(0));
                while left > 0 {
                    let n = std::cmp::min(left, 65536) as usize;
                    if f.write_all(&zeros[..n]).is_err() { break; }
                    left -= n as u64;
                }
                let _ = f.sync_all();
            }
        }
    }
    let _ = fs::remove_file(p);
}

#[tauri::command]
fn audio_discard(state: State<AppState>, path: String) -> Result<bool, String> {
    let (_m, _e, audio) = ai_dirs(&state)?;
    let p = PathBuf::from(&path); if p.starts_with(&audio) { secure_delete_file(&p); } Ok(true)
}
fn spawn_proc(ai: &State<AiState>, kind: &str, mut cmd: std::process::Command) -> Result<bool, String> {
    use std::io::Read as _;
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).stdin(std::process::Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt as _; cmd.creation_flags(0x08000000); }
    let mut child = cmd.spawn().map_err(|e| format!("Engine failed to start: {}", e))?;
    let out = child.stdout.take(); let err = child.stderr.take();
    let shared = Arc::new(Mutex::new(ProcShared { kind: kind.to_string(), progress: -1, ..Default::default() }));
    shared.lock().unwrap().child = Some(child);
    if let Some(mut so) = out { let sh = shared.clone(); std::thread::spawn(move || { let mut b = [0u8; 4096]; loop { match so.read(&mut b) { Ok(0) => break, Ok(n) => { sh.lock().unwrap().output.push_str(&String::from_utf8_lossy(&b[..n])); }, Err(_) => break } } }); }
    if let Some(se) = err { let sh = shared.clone(); std::thread::spawn(move || { use std::io::BufRead as _; let reader = std::io::BufReader::new(se); for line in reader.lines() { if let Ok(l) = line { let mut s = sh.lock().unwrap(); if let Some(pos) = l.rfind('%') { if let Some(num) = l[..pos].rsplit(|c: char| !c.is_ascii_digit()).next() { if let Ok(v) = num.parse::<i32>() { s.progress = v; } } } let tail = format!("{}\n{}", s.stderr_tail, l); s.stderr_tail = tail.chars().rev().take(1500).collect::<String>().chars().rev().collect(); } } }); }
    { let mut rt = ai.0.lock().unwrap(); rt.proc = Some(shared); }
    Ok(true)
}
#[tauri::command]
fn transcribe_start(state: State<AppState>, ai: State<AiState>, audio_path: String, model: String, lang: String, prompt: Option<String>, timestamps: Option<bool>) -> Result<bool, String> {
    let (models, engines, _a) = ai_dirs(&state)?;
    let bin = resolve_engine(&state, &engines, "whisper").ok_or("Transcription engine (whisper-cli) not found. Download the engine in Models, or set a custom engine path.")?;
    let model_path = if let Some(f) = model.strip_prefix("custom:") { models.join(f) } else { model_file(&models, "whisper", &model).ok_or("Unknown model")?.1 };
    if !model_path.exists() { return Err("The selected model has not been downloaded".into()); }
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("-m").arg(&model_path).arg("-f").arg(&audio_path).arg("-l").arg(if lang.is_empty() { "auto".to_string() } else { lang }).arg("-pp").arg("-t").arg("4");
    if timestamps != Some(true) { cmd.arg("--no-timestamps"); }
    // Optional vocabulary bias: the client name + clinician-supplied terms,
    // passed as whisper.cpp's initial prompt so names/medication/technical
    // terms are recognized more reliably.
    if let Some(p) = prompt { let p = p.trim(); if !p.is_empty() { cmd.arg("--prompt").arg(p); } }
    spawn_proc(&ai, "transcribe", cmd)
}
// Locate the fmt/data chunks of a PCM WAV (returns channels, sample rate,
// and the data chunk's byte span). The app records 16-bit mono 16 kHz WAVs.
fn wav_data_span(wav: &[u8]) -> Result<(u16, u32, usize, usize), String> {
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" { return Err("Not a WAV recording".into()); }
    let mut fmt: Option<(u16, u16, u32, u16)> = None;
    let mut data: Option<(usize, usize)> = None;
    let mut pos = 12usize;
    while pos + 8 <= wav.len() {
        let id = &wav[pos..pos + 4];
        let size = u32::from_le_bytes([wav[pos + 4], wav[pos + 5], wav[pos + 6], wav[pos + 7]]) as usize;
        let start = pos + 8; let end = start.saturating_add(size).min(wav.len());
        if id == b"fmt " && end - start >= 16 { fmt = Some((u16::from_le_bytes([wav[start], wav[start + 1]]), u16::from_le_bytes([wav[start + 2], wav[start + 3]]), u32::from_le_bytes([wav[start + 4], wav[start + 5], wav[start + 6], wav[start + 7]]), u16::from_le_bytes([wav[start + 14], wav[start + 15]]))); }
        if id == b"data" { data = Some((start, end - start)); }
        pos = start + size + (size % 2);
    }
    let (format, channels, rate, bits) = fmt.ok_or("WAV header not understood")?;
    if format != 1 || bits != 16 { return Err("Only uncompressed 16-bit WAV recordings can be combined".into()); }
    let (ds, dl) = data.ok_or("WAV has no audio data")?;
    Ok((channels, rate, ds, dl - (dl % 2)))
}
// Concatenate two WAVs with a silent gap — used to prepend the enrolled
// voice sample to a session recording so the diarization engine clusters
// the enrollment passage and the session in a single pass; the cluster
// that dominates the enrollment window is the therapist.
fn concat_wavs(first: &[u8], second: &[u8], gap_ms: u32) -> Result<Vec<u8>, String> {
    let (ch1, rate1, s1, l1) = wav_data_span(first)?;
    let (ch2, rate2, s2, l2) = wav_data_span(second)?;
    if ch1 != ch2 || rate1 != rate2 { return Err("The enrollment sample and the session recording use different audio formats and cannot be combined.".into()); }
    let gap_bytes = (rate1 as usize * gap_ms as usize / 1000) * 2 * ch1 as usize;
    let data_len = l1 + gap_bytes + l2;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF"); out.extend_from_slice(&(36u32 + data_len as u32).to_le_bytes()); out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt "); out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); out.extend_from_slice(&ch1.to_le_bytes());
    out.extend_from_slice(&rate1.to_le_bytes()); out.extend_from_slice(&(rate1 * ch1 as u32 * 2).to_le_bytes());
    out.extend_from_slice(&(ch1 * 2).to_le_bytes()); out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data"); out.extend_from_slice(&(data_len as u32).to_le_bytes());
    out.extend_from_slice(&first[s1..s1 + l1]);
    out.resize(out.len() + gap_bytes, 0);
    out.extend_from_slice(&second[s2..s2 + l2]);
    Ok(out)
}
#[tauri::command]
fn diarize_start(state: State<AppState>, ai: State<AiState>, audio_path: String, enroll_path: Option<String>, num_speakers: Option<i32>) -> Result<Value, String> {
    let (models, engines, audio) = ai_dirs(&state)?;
    let bin = resolve_engine(&state, &engines, "diarize").ok_or("Speaker separation engine not found. Download the engine in Models & Settings, or set a custom engine path.")?;
    let seg = model_file(&models, "diarize", "seg").ok_or("Unknown model")?.1;
    let emb = model_file(&models, "diarize", "emb").ok_or("Unknown model")?.1;
    if !seg.exists() || !emb.exists() { return Err("The speaker models have not been downloaded yet (Models & Settings).".into()); }
    let mut input = PathBuf::from(&audio_path);
    let mut combined = false;
    if let Some(ep) = enroll_path { let epb = PathBuf::from(&ep); if epb.exists() {
        let a = fs::read(&epb).map_err(|e| e.to_string())?;
        let b = fs::read(&input).map_err(|e| e.to_string())?;
        let merged = concat_wavs(&a, &b, 1000)?;
        let tmp = audio.join(format!("diarize-{}.wav", Uuid::new_v4()));
        fs::write(&tmp, &merged).map_err(|e| e.to_string())?;
        input = tmp; combined = true;
    } }
    let mut cmd = std::process::Command::new(bin);
    cmd.arg(format!("--segmentation.pyannote-model={}", seg.to_string_lossy())).arg(format!("--embedding.model={}", emb.to_string_lossy()));
    match num_speakers { Some(n) if n > 0 => { cmd.arg(format!("--clustering.num-clusters={}", n)); }, _ => { cmd.arg("--clustering.cluster-threshold=0.5"); } }
    cmd.arg(&input);
    spawn_proc(&ai, "diarize", cmd)?;
    Ok(json!({"input": input.to_string_lossy(), "combined": combined}))
}
#[tauri::command]
fn generate_start(state: State<AppState>, ai: State<AiState>, model: String, prompt: String) -> Result<bool, String> {
    let (models, engines, _a) = ai_dirs(&state)?;
    let bin = resolve_engine(&state, &engines, "llama").ok_or("Note engine (llama-cli) not found. Download the engine in Models, or set a custom engine path.")?;
    let model_path = if let Some(f) = model.strip_prefix("custom:") { models.join(f) } else { model_file(&models, "llm", &model).ok_or("Unknown model")?.1 };
    if !model_path.exists() { return Err("The selected model has not been downloaded".into()); }
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("-m").arg(&model_path).arg("-p").arg(prompt).arg("-n").arg("1024").arg("--temp").arg("0.3").arg("-t").arg("4").arg("--reverse-prompt").arg("<|im_end|>");
    spawn_proc(&ai, "generate", cmd)
}
#[tauri::command]
fn ai_proc_poll(ai: State<AiState>) -> Result<Value, String> {
    let rt = ai.0.lock().unwrap();
    if let Some(p) = &rt.proc { let mut s = p.lock().unwrap();
        if !s.done { if let Some(ch) = s.child.as_mut() { if let Ok(Some(status)) = ch.try_wait() { s.done = true; if !status.success() && s.output.trim().is_empty() { s.error = Some(format!("Engine exited ({}). {}", status, s.stderr_tail.trim())); } } } }
        return Ok(json!({"active": !s.done, "kind": s.kind, "progress": s.progress, "output": s.output, "done": s.done, "error": s.error}));
    }
    Ok(json!({"active": false, "done": true, "output": "", "progress": -1}))
}
#[tauri::command]
fn ai_proc_cancel(ai: State<AiState>) -> Result<bool, String> { let rt = ai.0.lock().unwrap(); if let Some(p) = &rt.proc { let mut s = p.lock().unwrap(); if let Some(ch) = s.child.as_mut() { let _ = ch.kill(); } s.error = Some("Cancelled".into()); s.done = true; } Ok(true) }

#[tauri::command] fn db_get_pref(state:State<AppState>,key:String)->Result<Option<String>,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;rt.db.as_ref().unwrap().query_row("SELECT value FROM preferences WHERE key=?",[key],|r|r.get(0)).optional().map_err(|e|e.to_string())}
#[tauri::command] fn db_set_pref(state:State<AppState>,key:String,val:String)->Result<bool,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;rt.db.as_ref().unwrap().execute("INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,val]).map_err(|e|e.to_string())?;Ok(true)}
#[tauri::command] fn db_remove_pref(state:State<AppState>,key:String)->Result<bool,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;rt.db.as_ref().unwrap().execute("DELETE FROM preferences WHERE key=?",[key]).map_err(|e|e.to_string())?;Ok(true)}
#[tauri::command] fn db_info(state:State<AppState>)->Result<Value,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;let p=rt.paths.as_ref().ok_or("Paths are not initialized")?;Ok(json!({"dbPath":p.db,"backupDir":p.backups,"dataDir":p.data,"portableMode":p.data.parent().map(|x|x.join("portable.mode").exists()).unwrap_or(false),"size":fs::metadata(&p.db).map(|m|m.len()).unwrap_or(0),"encrypted":true,"integrity":"ok"}))}
#[tauri::command] fn db_backup(state:State<AppState>)->Result<Value,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;let p=rt.paths.as_ref().ok_or("Paths are not initialized")?;rt.db.as_ref().unwrap().execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").map_err(|e|e.to_string())?;let file=p.backups.join(format!("notes_{}_manual.db",Utc::now().format("%Y-%m-%dT%H-%M-%S%.3f")));fs::copy(&p.db,&file).map_err(|e|e.to_string())?;let chk=open_db(&file,&rt.db_key.ok_or("Database is not unlocked")?)?;let ok:String=chk.query_row("PRAGMA integrity_check",[],|r|r.get(0)).map_err(|e|e.to_string())?;if ok.to_lowercase()!="ok"{let _=fs::remove_file(&file);return Err("Backup integrity verification failed".into())}audit(&rt,"Create database backup","Backup","","Success",file.file_name().and_then(|x|x.to_str()).unwrap_or(""))?;Ok(json!({"ok":true,"file":file,"verified":true}))}
#[tauri::command] fn audit_list(state:State<AppState>,limit:Option<u32>)->Result<Vec<Value>,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;let n=limit.unwrap_or(300).min(1000);let mut st=rt.db.as_ref().unwrap().prepare("SELECT id,ts,username,action,object_type,object_id,result,detail FROM audit_log ORDER BY id DESC LIMIT ?").map_err(|e|e.to_string())?;let rows=st.query_map([n],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"ts":r.get::<_,String>(1)?,"username":r.get::<_,String>(2)?,"action":r.get::<_,String>(3)?,"object_type":r.get::<_,Option<String>>(4)?,"object_id":r.get::<_,Option<String>>(5)?,"result":r.get::<_,String>(6)?,"detail":r.get::<_,Option<String>>(7)?}))).map_err(|e|e.to_string())?;Ok(rows.filter_map(Result::ok).collect())}
#[tauri::command] fn audit_event(state:State<AppState>,input:AuditEventInput)->Result<bool,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;audit(&rt,&input.action,input.object_type.as_deref().unwrap_or(""),input.object_id.as_deref().unwrap_or(""),"Success",input.detail.as_deref().unwrap_or(""))?;Ok(true)}
#[tauri::command] fn audit_verify(state:State<AppState>)->Result<Value,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;let mut st=rt.db.as_ref().unwrap().prepare("SELECT ts,user_id,username,action,object_type,object_id,result,detail,prev_hash,entry_hash FROM audit_log ORDER BY id").map_err(|e|e.to_string())?;let mut rows=st.query([]).map_err(|e|e.to_string())?;let mut prev="GENESIS".to_string();let key=audit_key(&rt)?;let mut ok=true;while let Some(r)=rows.next().map_err(|e|e.to_string())?{let vals:(String,Option<String>,String,String,Option<String>,Option<String>,String,Option<String>,String,String)=(r.get(0).map_err(|e|e.to_string())?,r.get(1).map_err(|e|e.to_string())?,r.get(2).map_err(|e|e.to_string())?,r.get(3).map_err(|e|e.to_string())?,r.get(4).map_err(|e|e.to_string())?,r.get(5).map_err(|e|e.to_string())?,r.get(6).map_err(|e|e.to_string())?,r.get(7).map_err(|e|e.to_string())?,r.get(8).map_err(|e|e.to_string())?,r.get(9).map_err(|e|e.to_string())?);let payload=format!("{}|{}|{}|{}|{}|{}|{}|{}|{}",vals.0,vals.1.unwrap_or_default(),vals.2,vals.3,vals.4.unwrap_or_default(),vals.5.unwrap_or_default(),vals.6,vals.7.unwrap_or_default(),prev);let mut mac=<HmacSha256 as Mac>::new_from_slice(&key).map_err(|e|e.to_string())?;mac.update(payload.as_bytes());let h=hex::encode(mac.finalize().into_bytes());if vals.8!=prev||vals.9!=h{ok=false;break}prev=vals.9}drop(rows);drop(st);audit(&rt,"Verify audit log","Audit log","",if ok{"Success"}else{"Failure"},if ok{"Integrity check passed"}else{"Audit log chain anomaly detected"})?;Ok(json!({"ok":ok}))}
#[tauri::command] fn users_list(state:State<AppState>)->Result<Vec<Value>,String>{let rt=state.0.lock().unwrap();require_admin(&rt)?;let mut st=rt.db.as_ref().unwrap().prepare("SELECT id,username,display_name,role,active,created_at,updated_at FROM users ORDER BY created_at").map_err(|e|e.to_string())?;let rows=st.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"username":r.get::<_,String>(1)?,"display_name":r.get::<_,String>(2)?,"role":r.get::<_,String>(3)?,"active":r.get::<_,i64>(4)?==1,"created_at":r.get::<_,String>(5)?,"updated_at":r.get::<_,String>(6)?}))).map_err(|e|e.to_string())?;Ok(rows.filter_map(Result::ok).collect())}
#[tauri::command] fn users_create(state:State<AppState>,input:CreateUserInput)->Result<OpResult,String>{let mut rt=state.0.lock().unwrap();require_admin(&rt)?;if input.username.trim().len()<2||input.password.len()<10{return Ok(OpResult{ok:false,error:Some("Username must be at least 2 characters; password at least 10 characters.".into()),user:None})}let salt=random16();let id=Uuid::new_v4().to_string();let role=if input.role=="Admin"{"Admin"}else{"Clinician"};let db=rt.db.as_ref().unwrap();let r=db.execute("INSERT INTO users(id,username,display_name,password_hash,salt,role,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)",params![id,input.username.trim(),if input.display_name.trim().is_empty(){input.username.trim()}else{input.display_name.trim()},password_hash(&input.password,&salt)?,hex::encode(salt),role,now(),now()]);if let Err(e)=r{return Ok(OpResult{ok:false,error:Some(format!("Create userFailure：{e}")),user:None})}let p=rt.paths.as_ref().unwrap();let mut a=read_access(&p.access);a.users.push(AccessUser{id:id.clone(),username:input.username.trim().into(),display_name:input.display_name.trim().into(),role:role.into(),active:true,salt:hex::encode(salt),verifier:verifier(&input.password,&salt)?,wrapped_key:wrap_key(&rt.db_key.unwrap(),&input.password,&salt)?});write_access(&p.access,&a)?;audit(&rt,"Create user","User",&id,"Success",role)?;Ok(OpResult{ok:true,error:None,user:None})}
#[tauri::command] fn users_set_active(state:State<AppState>,input:ActiveInput)->Result<OpResult,String>{let rt=state.0.lock().unwrap();let me=require_admin(&rt)?;if me.id==input.id&&!input.active{return Ok(OpResult{ok:false,error:Some("You cannot deactivate the account you are signed in with.".into()),user:None})}let db=rt.db.as_ref().unwrap();if !input.active {let target_role:Option<String>=db.query_row("SELECT role FROM users WHERE id=?",[&input.id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;if target_role.as_deref()==Some("Admin"){let active_admins:i64=db.query_row("SELECT COUNT(*) FROM users WHERE role='Admin' AND active=1",[],|r|r.get(0)).map_err(|e|e.to_string())?;if active_admins<=1{return Ok(OpResult{ok:false,error:Some("At least one active administrator account must remain.".into()),user:None})}}}db.execute("UPDATE users SET active=?,updated_at=? WHERE id=?",params![if input.active{1}else{0},now(),input.id]).map_err(|e|e.to_string())?;let p=rt.paths.as_ref().unwrap();let mut a=read_access(&p.access);if let Some(u)=a.users.iter_mut().find(|u|u.id==input.id){u.active=input.active}write_access(&p.access,&a)?;audit(&rt,if input.active{"Enable user"}else{"Disable user"},"User",&input.id,"Success","")?;Ok(OpResult{ok:true,error:None,user:None})}
#[tauri::command] fn change_password(state:State<AppState>,input:ChangePasswordInput)->Result<OpResult,String>{let rt=state.0.lock().unwrap();let u=require_user(&rt)?.clone();if input.new_password.len()<10{return Ok(OpResult{ok:false,error:Some("New password must be at least 10 characters.".into()),user:None})}let db=rt.db.as_ref().unwrap();let row:(String,String)=db.query_row("SELECT password_hash,salt FROM users WHERE id=?",[&u.id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;let oldsalt=hex::decode(row.1).map_err(|_|"Account credentials are corrupted".to_string())?;if !ct_eq_hex(&password_hash(&input.current_password,&oldsalt)?,&row.0){return Ok(OpResult{ok:false,error:Some("Current password is incorrect.".into()),user:None})}let salt=random16();db.execute("UPDATE users SET password_hash=?,salt=?,updated_at=? WHERE id=?",params![password_hash(&input.new_password,&salt)?,hex::encode(salt),now(),u.id]).map_err(|e|e.to_string())?;let p=rt.paths.as_ref().unwrap();let mut a=read_access(&p.access);if let Some(x)=a.users.iter_mut().find(|x|x.id==u.id){x.salt=hex::encode(salt);x.verifier=verifier(&input.new_password,&salt)?;x.wrapped_key=wrap_key(&rt.db_key.unwrap(),&input.new_password,&salt)?}write_access(&p.access,&a)?;audit(&rt,"Change password","User",&u.id,"Success","")?;Ok(OpResult{ok:true,error:None,user:None})}

#[tauri::command] fn open_path(app:AppHandle,state:State<AppState>,kind:String)->Result<bool,String>{let rt=state.0.lock().unwrap();require_user(&rt)?;let p=rt.paths.as_ref().ok_or("Paths are not initialized")?;let target=if kind=="backup"{&p.backups}else{&p.data};tauri_plugin_opener::OpenerExt::opener(&app).open_path(target.to_string_lossy().to_string(),None::<&str>).map_err(|e|e.to_string())?;Ok(true)}
#[tauri::command] fn open_external(app:AppHandle,url:String)->Result<bool,String>{
    // External links stay disabled in this PHI app, with one exception: the
    // developer credit link to the maker's own site (EN + ZH pages).
    if url=="https://mind.us"||url=="https://mind.us/zh" {
        tauri_plugin_opener::OpenerExt::opener(&app).open_url(url,None::<&str>).map_err(|e|e.to_string())?; Ok(true)
    } else { Err("External links are disabled in this app".into()) }
}

pub fn run(){tauri::Builder::default().plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_opener::init()).manage(AppState(Mutex::new(Runtime::default()))).manage(AiState(Mutex::new(AiRuntime::default()))).invoke_handler(tauri::generate_handler![startup_status,startup_setup,startup_login,auth_status,auth_lock,db_get_state,db_set_state,db_list_prefs,db_get_pref,db_set_pref,db_remove_pref,db_info,db_backup,audit_list,audit_verify,audit_event,users_list,users_create,users_set_active,change_password,open_path,open_external,ai_status,ai_download,ai_download_cancel,ai_set_engine_path,ai_import_model,audio_begin,audio_append,audio_finish,audio_snapshot,audio_discard,transcribe_start,diarize_start,generate_start,ai_proc_poll,ai_proc_cancel]).run(tauri::generate_context!()).expect("error while running Tauri application");}
