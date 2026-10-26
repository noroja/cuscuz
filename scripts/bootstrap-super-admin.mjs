import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createClient } from '@supabase/supabase-js';

const username = String(process.argv[2] || '').trim().toLowerCase();
if (!username) {
  console.error('Uso: node --env-file=.env scripts/bootstrap-super-admin.mjs <usuario-existente>');
  process.exit(2);
}
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente.');
  process.exit(2);
}
if (!input.isTTY) {
  console.error('Este comando exige terminal interativo para confirmar a promoção.');
  process.exit(2);
}

const host = new URL(url).host;
const rl = readline.createInterface({ input, output });
const typed = await rl.question(`Projeto Supabase: ${host}\nPromover a conta existente "${username}" para super_admin? Digite o nome exatamente para confirmar: `);
rl.close();
if (typed.trim().toLowerCase() !== username) {
  console.error('Confirmação não corresponde; nenhuma alteração foi feita.');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: existingAdmin, error: adminError } = await supabase.from('users')
  .select('username').eq('role', 'super_admin').limit(1);
if (adminError) throw new Error(`Não foi possível verificar administradores: ${adminError.message}`);
if (existingAdmin?.length) throw new Error(`Já existe super_admin (${existingAdmin[0].username}). Use o painel administrativo.`);

const { data: target, error: userError } = await supabase.from('users')
  .select('username,is_active,role').eq('username', username).maybeSingle();
if (userError) throw new Error(`Não foi possível localizar a conta: ${userError.message}`);
if (!target) throw new Error('A conta não existe. Este comando não cria contas.');
if (target.is_active === false) throw new Error('A conta está suspensa; reative-a antes da promoção.');

const { error: auditError } = await supabase.from('auth_admin_audit').insert({
  actor_username: 'operator_bootstrap',
  action: 'user.primary_admin_bootstrap',
  target_username: username,
  metadata: { previous_role: target.role || 'user', project_host: host }
});
if (auditError) throw new Error(`A trilha de auditoria não está pronta; nenhuma promoção foi feita: ${auditError.message}`);

const { error: updateError } = await supabase.from('users').update({ role: 'super_admin', is_primary_admin: true }).eq('username', username);
if (updateError) throw new Error(`Falha ao promover a conta: ${updateError.message}`);
console.log(`Conta existente "${username}" promovida a super_admin em ${host}. Nenhuma senha foi criada ou alterada.`);
