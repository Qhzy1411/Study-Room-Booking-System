import path from 'node:path';
import { projectFile, outputDir } from './运行路径.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const { startTestServer } = await import(projectFile('tests/helpers/server.js'));
const { createApiClient, key, setClock } = await import(projectFile('tests/helpers/client.js'));
const { addDaysLocal } = await import(projectFile('server/time.js'));

const results = [];
function check(id, expected, actual, context = {}) {
  let passed = true;
  try { assert.deepEqual(actual, expected); } catch { passed = false; }
  results.push({id, passed, expected, actual, context});
  console.log(id, passed ? 'PASS' : 'FAIL', JSON.stringify(actual));
}
function ok(response, status = 200) {
  assert.equal(response.status, status, JSON.stringify(response.json));
  return response.json;
}
async function fixture(name, run) {
  let server;
  try {
    server = await startTestServer();
    const [sys, manager, a, b] = await Promise.all(['s1','m1','u01','u02'].map(async username => {
      const client = createApiClient(server.base);
      await client.login(username);
      return client;
    }));
    const today = ok(await sys.get('/system/clock')).nowText.slice(0,10);
    await setClock(sys, today + ' 08:00');
    await run({sys,manager,a,b,today,day:addDaysLocal(today,1)});
  } catch (e) {
    results.push({fixture:name,error:String(e.stack)});
    console.error(name, String(e));
  } finally { await server?.close(); }
}
const book = (c, date, seat, extras = {}) => c.post('/reservations',
  {roomId:'R1',seatId:'R1-'+seat,date,start:'10:00',end:'11:00',...extras},{key:key()});
const lookup = async (c, date, room='R1', needPower=false) => ok(await c.get(
  '/availability?'+new URLSearchParams({roomId:room,date,start:'10:00',end:'11:00',needPower})));
const publish = (c, from, to, start='08:00', end='22:00') =>
  c.post('/admin/rooms/R1/plans',{dateFrom:from,dateTo:to,start,end});

await fixture('排班', async ({sys, manager, a, today}) => {
  const missing = addDaysLocal(today,7);
  await setClock(sys,missing+' 08:00');
  for (const room of ['R1','R2']) {
    const view = await lookup(a,missing,room);
    check('P01-'+room, true, view.seats.length>0 && view.seats.every(s=>s.state==='closed'),
      {date:missing,seats:view.seats.length,reason:view.seats[0]?.reason});
  }
  ok(await publish(manager,missing,missing));
  const after = await lookup(a,missing);
  const res = ok(await book(a,missing,'A01'),201).reservation;
  check('P02',['available','pending'],[after.seats.find(s=>s.code==='A01').state,res.status]);
  const rejected = await publish(manager,missing,missing,'12:00','20:00');
  const kept = ok(await a.get('/rooms/R1')).plans.find(p=>p.date===missing);
  check('P03',[409,'08:00','22:00'],[rejected.status,kept.start,kept.end]);
  // 模拟连续两个月正常发布，最后一天用学生端和管理端分别查看。
  for (const offset of [1,32]) ok(await publish(manager,addDaysLocal(missing,offset),addDaysLocal(missing,offset+30)));
  const last = addDaysLocal(missing,62);
  await setClock(sys,last+' 08:00');
  const plans = ok(await manager.get('/admin/rooms/R1')).plans;
  const visible = ok(await a.get('/rooms/R1')).plans.find(p=>p.date===last);
  check('P04',[true,true],[!!visible && !visible.closed,plans.some(p=>p.date===last)],
    {date:last,managerCount:plans.length,first:plans[0]?.date,lastShown:plans.at(-1)?.date,studentPlan:visible});
});

await fixture('合法换座与原座停用',async ({manager,a,b,day})=>{
  const original = ok(await book(a,day,'A01'),201).reservation;
  ok(await a.post('/reservations/'+original.id+'/site-issues',
    {type:'facility',description:'现场报告原座位插座接触不良，申请更换。'},{key:key()}),201);
  const swapped = ok(await a.post('/reservations/'+original.id+'/swap',
    {targetSeatId:'R1-A04',expectedVersion:original.version},{key:key()})).reservation;
  check('S01',[original.id,'A04',original.status],[swapped.id,swapped.seatCode,swapped.status]);
  const old = (await lookup(b,day)).seats.find(s=>s.code==='A01');
  const second = await book(b,day,'A01');
  check('S02',['available',201],[old.state,second.status],{reason:second.json.error?.message});
  if(second.status===201) ok(await b.post('/reservations/'+second.json.reservation.id+'/cancel',{},{key:key()}));
  const payload={seatId:'R1-A01',immediate:false,startAt:day+' 10:00',endAt:day+' 11:00',reason:'仅检修原座A01'};
  const preview=ok(await manager.post('/admin/suspensions/preview',payload));
  ok(await manager.post('/admin/suspensions',{...payload,impactHash:preview.impactHash,cleared:false},{key:key()}),201);
  const final=ok(await a.get('/reservations/'+original.id)).reservation;
  check('S03',[false,'A04','pending'],[preview.affected.some(r=>r.id===original.id),final.seatCode,final.status],
    {reservation:original.id,affected:preview.affected.map(r=>r.id),reason:final.cancelReason});
});

await fixture('历史报表',async ({sys,manager,a,day})=>{
  // 用未来一天作为统计日，避免演示种子中已有使用记录。
  const r=ok(await book(a,day,'A01'),201).reservation;
  await setClock(sys,day+' 10:00');
  const qr=ok(await manager.get('/admin/seats/R1-A01/qr')).text;
  ok(await a.post('/reservations/'+r.id+'/checkin',{code:qr},{key:key()}));
  await setClock(sys,day+' 11:01');
  ok(await a.get('/reservations/'+r.id));
  await setClock(sys,addDaysLocal(day,1)+' 12:00');
  const metrics=async()=>ok(await manager.get('/admin/stats?roomId=R1&date='+day+'&start=10:00&end=11:00')).metrics;
  const tuple=m=>[m.availableSeatMinutes,m.usageMinutes,m.usageRate];
  const before=tuple(await metrics());
  check('H01',[960,60,6.3],before,{date:day});
  ok(await manager.patch('/admin/seats/R1-A01',{archived:true,reason:'次日撤除A01'}));
  const archived=tuple(await metrics());
  check('H02',before,archived,{date:day,baseline:before});
  ok(await manager.patch('/admin/seats/R1-A01',{archived:false,reason:'恢复后独立核对新增座位'}));
  const restored=tuple(await metrics());
  assert.deepEqual(restored,before);
  ok(await manager.post('/admin/seats',{roomId:'R1',code:'Z99'}));
  check('H03',before,tuple(await metrics()),{date:day,baseline:restored});
});

await fixture('开馆前预约与设施变更',async ({sys,manager,a,b,today,day})=>{
  await setClock(sys,today+' 07:30');
  const url='/admin/stats?roomId=R1&date='+today+'&start=07:00&end=08:00';
  const initial=ok(await manager.get(url)).metrics.createdCount;
  const created=ok(await book(a,day,'A01'),201).reservation;
  await setClock(sys,today+' 09:00');
  const got=ok(await manager.get(url)).metrics.createdCount;
  check('H04',1,got-initial,{date:today,before:initial,after:got,reservation:created.id,createdAt:created.createdAtText});
  const candidates=await lookup(b,day,'R1',true);
  const seat=candidates.seats.find(s=>s.state==='available' && s.power==='normal');
  assert.ok(seat);
  ok(await manager.patch('/admin/seats/'+seat.id+'/facility',{status:'faulty',note:'现场已核实插座损坏'}));
  const outdated=await book(b,day,seat.code,{needPower:true});
  const fresh=(await lookup(b,day,'R1',true)).seats.find(s=>s.id===seat.id);
  check('F01',[422,'facility'],[outdated.status,fresh.state],{seat:seat.code});
  ok(await manager.patch('/admin/seats/'+seat.id+'/facility',{status:'normal',note:'现场验收通过'}));
  const freshBooking=await book(b,day,seat.code,{needPower:true});
  check('F02',201,freshBooking.status);
});
writeFileSync(path.join(outputDir,'第一轮业务验收结果.json'),JSON.stringify({node:process.version,executedAt:new Date(),results},null,2)+'\n');
process.exitCode=results.some(r=>!r.passed)?1:0;
