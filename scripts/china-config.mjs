import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const requiredNames = ['CHINA_HOST', 'CHINA_SSH_USER', 'CHINA_DOMAIN', 'CHINA_SSH_PRIVATE_KEY', 'CHINA_SSH_KNOWN_HOSTS'];
const dns = value => typeof value === 'string' && value.length <= 253 && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
const ipv4 = value => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && value.split('.').every(x => Number(x) <= 255);
export function checkChinaConfig(env) {
  const missing = requiredNames.filter(name => typeof env[name] !== 'string' || !env[name].trim());
  const invalid = [];
  if (env.CHINA_HOST && !(ipv4(env.CHINA_HOST) || dns(env.CHINA_HOST))) invalid.push('CHINA_HOST');
  if (env.CHINA_SSH_USER && !/^[a-z_][a-z0-9_-]{0,31}$/.test(env.CHINA_SSH_USER)) invalid.push('CHINA_SSH_USER');
  if (env.CHINA_DOMAIN && (!dns(env.CHINA_DOMAIN) || !/\.[a-z]{2,63}$/.test(env.CHINA_DOMAIN) || /(?:^|\.)(localhost|test|example|invalid)$/.test(env.CHINA_DOMAIN))) invalid.push('CHINA_DOMAIN');
  const port = env.CHINA_SSH_PORT || '22';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) invalid.push('CHINA_SSH_PORT');
  return { ready: missing.length === 0 && invalid.length === 0, missing, invalid };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkChinaConfig(process.env);
  console.log(result.ready ? 'Domestic server connection is configured.' : `Domestic deployment is blocked. Missing: ${result.missing.join(', ') || 'none'}. Invalid: ${result.invalid.join(', ') || 'none'}.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `ready=${result.ready}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, result.ready ? '国内服务器接入配置已齐备；继续构建完整包并部署到该服务器。\n' : `国内上线尚未执行。缺少配置：${result.missing.join('、') || '无'}。需要修正的配置：${result.invalid.join('、') || '无'}。只报告配置名称，不输出密钥或配置值。\n`);
}
