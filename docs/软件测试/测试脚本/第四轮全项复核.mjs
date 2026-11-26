import { projectFile, outputDir } from './运行路径.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {runInNewContext} from 'node:vm';
const {AppError} = await import(projectFile('server/errors.js'));
const {startTestServer,projectRoot} = await import(projectFile('tests/helpers/server.js'));
const {createApiClient,key,setClock} = await import(projectFile('tests/helpers/client.js'));
const {addDaysLocal} = await import(projectFile('server/time.js'));

const folder=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.join(projectRoot,'package.json'));
const output={started:new Date().toISOString(),node:process.version,items:[]};
const save=()=>fs.writeFileSync(path.join(outputDir,'第四轮补测结果.json'),JSON.stringify(output,null,2)+'\n');
async function item(id,method,work){
  try {const observations=await work();output.items.push({id,method,observations});}
  catch(e){output.items.push({id,method,setupError:String(e.stack)});}
  save();console.log(id,output.items.at(-1).setupError||'已记录');
}
function cmd(executable,args,options={}){
  const r=spawnSync(executable,args,{cwd:projectRoot,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024,...options});
  if(r.error||r.status!==0)throw Error(String(r.error||r.stderr||r.stdout).slice(-2000));
  return r.stdout;
}
const ok=r=>{assert.ok(r.status>=200&&r.status<300,JSON.stringify(r.json));return r.json;};
const read=f=>fs.readFileSync(path.join(projectRoot,f),'utf8');
// 像中间件单元测试一样，直接给项目的错误处理器传入异常对象，仅记录响应。
// 不启动接口来制造异常，响应对象也不发送网络数据。
function mappedStatus(error){
  const source=read('server/index.js');
  const begin=source.indexOf('app.use((err, req, res, next)');
  const end=source.indexOf('\n});',begin);
  assert.ok(begin>=0 && end>begin);
  let handler,status;
  runInNewContext(source.slice(begin,end+4),{app:{use:fn=>{handler=fn;}},AppError,SyntaxError,console:{error(){}}});
  handler(error,{}, {status(code){status=code;return this;},json(){}},()=>{});
  assert.ok(Number.isInteger(status));return status;
}
if (!process.argv.includes('--supplement-only')) {
  cmd(process.execPath, ['--no-warnings', path.join(folder, '第三轮组员报告复测.mjs')], {
    env: { ...process.env, BUSINESS_RERUN: '1' }
  });
}
const previous=JSON.parse(fs.readFileSync(path.join(outputDir,'第四轮业务重跑结果.json')));
assert.equal(previous.records.filter(r=>r.status==='test_error').length,0);
output.businessRerun={started:previous.started,finished:previous.finished,checks:previous.records.length,baseline:previous.after};
const chrome=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(x=>x&&fs.existsSync(x));
const browser=await require('playwright-core').chromium.launch({executablePath:chrome,headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
let server,db;
try{
  server=await startTestServer({env:{TICK_INTERVAL_MS:'600000'}});
  db=new DatabaseSync(server.dbPath);
  const user=async(name)=>{const c=createApiClient(server.base);await c.login(name);return c;};
  const [a,m,sys]=await Promise.all(['u01','m1','s1'].map(user));
  const date=ok(await sys.get('/system/clock')).nowText.slice(0,10);
  const day=addDaysLocal(date,1);await setClock(sys,date+' 08:00');
  const booked=ok(await a.post('/reservations',{roomId:'R1',seatId:'R1-A01',date:day,start:'10:00',end:'11:00'},{key:key()})).reservation;
  const pgLogin=async(pg,account)=>{
    await pg.locator('#login-username').fill(account);await pg.locator('#login-password').fill('123456');
    await pg.locator('#login-password').press('Enter');await pg.locator('.nav a').first().waitFor();
  };
  await item('F05','授权场地正常查询＋代码核对',async()=>{
    const result=await m.get('/admin/suspensions?roomId=R1');ok(result);
    const grants=ok(await m.get('/auth/me')).user.grants;
    return {grants,authorizedStatus:result.status,authorizedRows:result.json.suspensions.length,roomScopePassedToList:read('server/routes.js').includes('listSuspensions(req.user,'),unauthorizedRequestRun:false};
  });
  await item('F06','有效选座请求＋界面正常输入防错',async()=>{
    const pg=await browser.newPage();
    try {await pg.goto(server.base);await pgLogin(pg,'u02');
      await pg.locator('.toolbar-card select').nth(1).selectOption(day);
      const t=pg.locator('.toolbar-card input[type=time]');await t.nth(0).fill('12:00');await t.nth(1).fill('11:00');
      await pg.getByRole('button',{name:'查询座位'}).click();await pg.getByText('结束时间必须晚于开始时间',{exact:true}).waitFor();
      const result=await a.get('/availability?roomId=R1&date='+day+'&start=10:00&end=11:00');ok(result);
      return {completeQuery:result.status,reversedTimes:'页面提示结束时间必须晚于开始时间',bindingTypeErrorMappedTo:mappedStatus(new TypeError('模拟绑定异常')),missingParameter500:'未向接口发送缺参请求'};
    }finally{await pg.close();}
  });
  await item('F07','业务复核授权正例＋查询分支核对',async()=>{
    const info=ok(await sys.get('/auth/me')).user;assert.ok(info.canReview);
    const calls={};for(const field of ['violations','faults']){const r=await sys.get('/admin/'+field);ok(r);calls[field]=r.status;}
    return {canReview:info.canReview,authorizedQueries:calls,unauthorizedRequestRun:false};
  });
  await item('F15','有效依据创建限制＋数据核对',async()=>{
    const basis=db.prepare("select id from violations where user_id='U03' and room_id='R1' and status='effective' limit 1").get().id;
    const r=await m.post('/admin/limits',{roomScope:'R1',userId:'U03',startAt:day+' 15:00',endAt:day+' 16:00',reason:'合成现场记录已复核',violationIds:[basis]});
    ok(r);const n=db.prepare("select count(*) n from limit_basis b join limits l on l.id=b.limit_id where l.reason=?").get('合成现场记录已复核').n;assert.equal(n,1);
    return {status:r.status,basisRows:n,uiUsesSet:read('public/js/views/admin-review.js').includes('violationIds: new Set()'),constraintErrorMappedTo:mappedStatus(Object.assign(new Error('模拟存储约束错误'),{code:'ERR_SQLITE_ERROR'})),duplicateSubmissionRun:false};
  });
  await item('F16','正常无会话及有会话对照＋解析逻辑核对',async()=>{
    const anonymous=await createApiClient(server.base).get('/health'),me=await a.get('/auth/me');ok(anonymous);ok(me);
    return {healthWithoutCookie:anonymous.status,normalBrowserSession:me.status,decoderErrorMappedTo:mappedStatus(new URIError('模拟解码异常')),malformedCookieSent:false};
  });
  await item('F17','页面支持的最长投诉说明正常提交＋请求上限配置核对',async()=>{
    const description='课'.repeat(2000);
    const r=await a.post('/complaints',{type:'service',roomId:'R1',description},{key:key()});ok(r);
    return {visibleFormMax:read('public/js/views/feedback.js').includes('maxlength: 2000'),acceptedCharacters:r.json.complaint.description.length,status:r.status,parserLimit:read('server/index.js').match(/express\.json\(\{ limit: '([^']+)'/)[1],parser413MappedTo:mappedStatus(Object.assign(new Error('模拟解析器大小限制'),{status:413,type:'entity.too.large'})),oversizedRequestSent:false};
  });
  await setClock(sys,day+' 10:01');
  await item('F20','浏览器模拟相机连续识别；拦截签到请求并模拟识别错误',async()=>{
    const pg=await browser.newPage();
    try{
      await pg.addInitScript(()=>{window.BarcodeDetector=class{async detect(){return [{rawValue:'模拟桌面标识'}];}};});
      let requests=0;
      await pg.route('**/api/reservations/*/checkin',route=>{requests++;return route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:{message:'模拟识别失败'}})});});
      await pg.goto(server.base);await pgLogin(pg,'u01');
      await pg.locator('.nav a').filter({hasText:'我的预约'}).click();
      await pg.getByRole('button',{name:'扫码签到',exact:true}).first().click();await pg.getByText('模拟识别失败',{exact:true}).waitFor();
      const initial=requests;await pg.waitForTimeout(1300);const retries=requests-initial;
      await pg.getByRole('button',{name:'关闭',exact:true}).last().click();const stopped=requests;await pg.waitForTimeout(650);
      return {observationMs:1300,retriesWithoutUserAction:retries,requestsAfterClose:requests-stopped,realCheckinRequests:0};
    }finally{await pg.close();}
  });
  await item('F14','管理员正常辅助签到及数据库回读',async()=>{
    const note='已核对本人和桌号';const r=await m.post('/admin/reservations/'+booked.id+'/assist-checkin',{note,seatId:'R1-A01'});ok(r);
    const stored=db.prepare('select method,note from checkins where reservation_id=?').get(booked.id);
    assert.equal(stored.note,note);return {status:r.status,stored,bindingTypeErrorMappedTo:mappedStatus(new TypeError('模拟绑定异常')),nonTextNoteSent:false};
  });
  await item('F22','同一浏览器正常换用两个合成账号，仅观察非个人的同意勾选',async()=>{
    const pg=await browser.newPage();const consent=pg.locator('aside .check input[type=checkbox]');
    try{
      await pg.goto(server.base);await pgLogin(pg,'u01');await consent.waitFor({state:'attached'});
      const firstInitial=await consent.isChecked();await consent.check();assert.ok(await consent.isChecked());
      await pg.locator('.profile-btn').click();await pg.getByRole('button',{name:'退出登录'}).click();
      await pgLogin(pg,'u02');await consent.waitFor({state:'attached'});
      const secondInitial=await consent.isChecked();
      await pg.getByRole('button',{name:'查询座位'}).click();
      await pg.getByRole('button',{name:'选择',exact:true}).first().click();
      return {firstInitial,firstBeforeLogout:true,secondInitial,afterNewSeat:await consent.isChecked(),personalDataExposureTested:false};
    }finally{await pg.close();}
  });
  await item('F24','对照同一个新建场地管理员的配置值与登录资料',async()=>{
    const id='scope24';ok(await sys.post('/admin/users',{username:id,password:'123456',displayName:'场地职责对照',role:'venue_admin',grants:['R1'],permissions:{canStats:false,canReview:false}}));
    const c=await user(id),dto=ok(await c.get('/auth/me')).user;
    const stored=db.prepare('select can_stats,can_review from business_permissions where user_id=?').get(dto.id);
    return {stored,sessionProfile:{canStats:dto.canStats,canReview:dto.canReview},grants:dto.grants,ungrantedBusinessDataRequested:false};
  });
  await item('F25','独立配置加载、正常登录的 Cookie 属性、关闭演示模式启动对照',async()=>{
    const env={...process.env};delete env.DEMO_MODE;delete env.QR_SECRET;
    const defaults=JSON.parse(cmd(process.execPath,['--input-type=module','-e',"import c from './server/config.js'; console.log(JSON.stringify({demo:c.demoMode,host:c.host,builtInQrValue:Boolean(c.qrSecret)}))"],{env}));
    const login=await createApiClient(server.base).post('/auth/login',{username:'u02',password:'123456'});ok(login);
    const cookie=login.headers.getSetCookie().join(';');
    const off=await startTestServer({env:{DEMO_MODE:'0'}});try{
      const c=createApiClient(off.base);await c.login('s1');
      const clock=ok(await c.get('/system/clock'));
      const student=createApiClient(off.base);await student.login('u01');
      ok(await student.post('/reservations',{roomId:'R1',seatId:'R1-A01',date:addDaysLocal(clock.nowText.slice(0,10),1),start:'10:00',end:'11:00'},{key:key()}));
      const pg=await browser.newPage();let ownCodeButton;
      try{
        await pg.goto(off.base);await pgLogin(pg,'u01');await pg.locator('.nav a').filter({hasText:'我的预约'}).click();
        await pg.getByRole('button',{name:'扫码签到',exact:true}).first().click();
        ownCodeButton=await pg.getByRole('button',{name:'使用本人桌面码签到'}).isVisible();
      }finally{await pg.close();}
      return {defaults,demoAfterExplicitOff:clock.demoMode,ownCodeButtonVisibleWithDemoOff:ownCodeButton,cookieFlags:{httpOnly:/;\s*HttpOnly/i.test(cookie),secure:/;\s*Secure/i.test(cookie),sameSite:/SameSite=(\w+)/i.exec(cookie)?.[1]},realDeploymentInspected:false};
    }finally{await off.close();}
  });
}finally{db?.close();await browser.close();await server?.close();}
await item('F26','逐项清点可取得的交付 ZIP 与桌面目录，比较压缩包内源文件哈希',async()=>{
  const archive=process.env.DELIVERY_ZIP;
  assert.ok(archive && fs.existsSync(archive), '交付包清点需要将 DELIVERY_ZIP 设为原始项目压缩包路径');
  const desktop=process.env.ORIGINAL_PROJECT||projectRoot;
  const python=String.raw`
import sys,zipfile,hashlib,json,pathlib
archive=pathlib.Path(sys.argv[1]); desktop=pathlib.Path(sys.argv[2]); root=pathlib.Path(sys.argv[3])
with zipfile.ZipFile(archive,metadata_encoding='gbk') as z:
    names=set(z.namelist()); compare={}
    for prefix in ['server/','public/','tests/']:
        sources={p.relative_to(root).as_posix():p for p in (root/prefix).rglob('*') if p.is_file()}
        same=sum(n in names and hashlib.sha256(z.read(n)).digest()==hashlib.sha256(p.read_bytes()).digest() for n,p in sources.items())
        compare[prefix]={'referenceFiles':len(sources),'identical':same,'additionalInZip':len([n for n in names if n.startswith(prefix) and not n.endswith('/') and n not in sources])}
    paths=['.git','coverage','tests/practice','data/studyroom.db','data/studyroom.db-wal','data/studyroom.db-shm','LICENSE']
    inventory={n:{'zip':any(x==n or x.startswith(n+'/') for x in names),'desktop':(desktop/n).exists()} for n in paths}
    print(json.dumps({'zipName':archive.name,'zipSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'inventory':inventory,'sourceComparison':compare,'zipTotalFiles':sum(not n.endswith('/') for n in names)}))
`;
  return JSON.parse(cmd('python',['-c',python,archive,desktop,projectRoot]));
});
await item('F27','运行项目原有浏览器用例，并与本轮管理端实测对照',async()=>{
  const report=path.join(outputDir,'第四轮浏览器回归结果.json');
  cmd(process.execPath,['--no-warnings','node_modules/vitest/vitest.mjs','run','tests/e2e/app.spec.js','--reporter=json','--outputFile',report]);
  const results=JSON.parse(fs.readFileSync(report,'utf8'));
  assert.ok(results.numPassedTests>0);
  return {passed:results.numPassedTests,failed:results.numFailedTests,skipped:results.numPendingTests,
    tests:results.testResults.flatMap(file=>file.assertionResults.map(x=>({name:x.title,status:x.status}))),
    coverageIncludes:[...read('vitest.config.js').matchAll(/'(server\/[^']+|public\/[^']+)'/g)].map(x=>x[1]),
    missingScenariosObservedInBusinessRerun:previous.records.filter(r=>['F03','F04','F13'].includes(r.id)).map(r=>({id:r.id,case:r.part,outcome:r.status}))};
});
output.finished=new Date().toISOString();save();
if(output.items.some(r=>r.setupError))process.exitCode=2;
