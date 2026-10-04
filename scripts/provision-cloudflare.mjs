import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export async function provision(env=process.env,fetcher=fetch){
  const account=env.CF_ACCOUNT_ID||'',token=env.CLOUDFLARE_API_TOKEN||'';
  if(!account||!token){
    if(env.CF_DEPLOY_EVENT==='push')return {configured:false};
    throw new Error('请先在 GitHub 仓库配置变量 CF_ACCOUNT_ID 和密钥 CF_API_TOKEN，再手动运行部署。');
  }
  if(!/^[a-f0-9]{32}$/i.test(account))throw new Error('CF_ACCOUNT_ID 应为 Cloudflare 控制台中的 32 位账户 ID。');
  const databaseName=env.CF_D1_DATABASE_NAME||'tennis-club';
  const bucketName=env.CF_R2_BUCKET_NAME||'tennis-club';
  const requestedId=env.CF_D1_DATABASE_ID||'';
  if(!/^[a-z][a-z0-9_-]{0,62}$/.test(databaseName))throw new Error('CF_D1_DATABASE_NAME 无效。');
  if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName))throw new Error('CF_R2_BUCKET_NAME 应为 3–63 位小写字母、数字或连字符。');
  if(requestedId&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestedId))throw new Error('CF_D1_DATABASE_ID 应为数据库 UUID。');
  const base=`https://api.cloudflare.com/client/v4/accounts/${account}`;
  async function api(path,{method='GET',body,allowMissing=false}={}){
    const response=await fetcher(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    let data;try{data=await response.json();}catch{throw new Error(`Cloudflare ${method} 请求返回了无效响应（HTTP ${response.status}）。`);}
    if(allowMissing&&response.status===404)return null;
    if(!response.ok||!data.success){
      const messages=(data.errors||[]).map(e=>e.message||e.code).join('；');
      throw new Error(`Cloudflare ${method} ${path.split('?')[0]} 失败（HTTP ${response.status}）${messages?'：'+messages:''}。请检查账户 ID、Token 权限及 R2 是否已开通。`);
    }
    return data;
  }
  let database;
  if(requestedId){
    database=(await api(`/d1/database/${requestedId}`)).result;
  }else{
    for(let page=1;page<=100;page++){
      const list=await api(`/d1/database?per_page=100&page=${page}`);
      const items=list.result||[];
      database=items.find(d=>d.name===databaseName);
      if(database||items.length<100)break;
      if(page===100)throw new Error('数据库过多，请通过 CF_D1_DATABASE_ID 指定要使用的数据库。');
    }
    if(!database)database=(await api('/d1/database',{method:'POST',body:{name:databaseName}})).result;
  }
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database?.uuid||'')||!/^[a-z][a-z0-9_-]{0,62}$/.test(database?.name||''))throw new Error('Cloudflare 未返回有效的 D1 数据库信息；请检查数据库名称和 UUID。');
  const bucket=await api(`/r2/buckets/${bucketName}`,{allowMissing:true});
  if(!bucket)await api('/r2/buckets',{method:'POST',body:{name:bucketName}});
  return {configured:true,databaseId:database.uuid,databaseName:database.name,bucketName};
}

async function main(){
  const result=await provision();
  if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,`configured=${result.configured}\n`);
  if(!result.configured){console.log('::notice::源码检查与构建已完成；等待配置 CF_ACCOUNT_ID 与 CF_API_TOKEN 后再部署完整应用。');return;}
  if(process.env.GITHUB_ENV)await fs.appendFile(process.env.GITHUB_ENV,`CF_D1_DATABASE_ID=${result.databaseId}\nCF_D1_DATABASE_NAME=${result.databaseName}\nCF_R2_BUCKET_NAME=${result.bucketName}\n`);
  console.log(`Cloudflare 存储已就绪：D1 ${result.databaseName}，R2 ${result.bucketName}。`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
