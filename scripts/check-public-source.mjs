import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const forbidden=[
 [/\b(?:thinkering|slack-concierge|remote-box)\b/i,'private project identifier'],
 [/\/root\/|\/home\/(?!user\/)|\/Users\//,'machine-specific path'],
 [/[A-Z0-9._%+-]+@(?!example\.)[A-Z0-9.-]+\.[A-Z]{2,}/i,'non-example email address'],
 [/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,'private key'],
 [/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/,'credential token'],
 [/\b(?:data-identifier|challenges\.cloudflare\.com|xdotool)\b/i,'private sign-in or challenge automation']
];
const failures=[];
function inspect(file,contents,label=file){
 if(file==='package-lock.json'||file==='scripts/check-public-source.mjs')return;
 const source=contents.replaceAll('contributors@users.noreply.github.com','');
 for(const [pattern,reason] of forbidden)if(pattern.test(source))failures.push(`${label}: ${reason}`);
}
for(const file of files)inspect(file,readFileSync(file,'utf8'));
if(process.argv.includes('--history')){
 const commits=execFileSync('git',['rev-list','--all'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
 for(const commit of commits){
  const identities=execFileSync('git',['show','-s','--format=%an%n%ae%n%cn%n%ce',commit],{encoding:'utf8'}).trim().split('\n');
  if(identities[0]!=='Contributors'||identities[1]!=='contributors@users.noreply.github.com'||identities[2]!=='Contributors'||identities[3]!=='contributors@users.noreply.github.com')failures.push(`${commit.slice(0,8)}: personal Git author or committer metadata`);
  const paths=execFileSync('git',['ls-tree','-r','--name-only',commit],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  for(const file of paths){
   if(file==='package-lock.json'||file==='scripts/check-public-source.mjs')continue;
   const contents=execFileSync('git',['show',`${commit}:${file}`],{encoding:'utf8'});
   inspect(file,contents,`${commit.slice(0,8)}:${file}`);
  }
 }
}
if(failures.length){process.stderr.write(failures.join('\n')+'\n');process.exit(1);}
process.stdout.write(`Checked ${files.length} source files${process.argv.includes('--history')?' and Git history':''} for public-source exclusions.\n`);
