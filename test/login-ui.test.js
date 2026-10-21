import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function page(loginResponse) {
  const elements = new Map(), requests = [], navigations = [], button = { disabled:false };
  const element = id => {
    if (!elements.has(id)) elements.set(id, { querySelector:() => button });
    return elements.get(id);
  };
  runInNewContext(source, {
    document:{ getElementById:element },
    window:{ location:{ assign:url => navigations.push(url) } },
    fetch:async (path, init) => {
      requests.push({path,init});
      return path === '/api/status' ? Response.json({configured:true,loggedIn:false}) : loginResponse();
    }
  });
  return {element,requests,navigations,button};
}
test('login prevents native form navigation and navigates only after JSON response', async () => {
  const url = 'https://platform.example/oauth/authorize?state=example';
  const p = page(() => Response.json({authorizationUrl:url}));
  let prevented = false;
  await p.element('login').onsubmit({preventDefault() {prevented=true;}});
  assert.equal(prevented,true);
  const request = p.requests.find(r => r.path === '/auth/login');
  assert.equal(request.init.method,'POST');
  assert.equal(request.init.credentials,'same-origin');
  assert.deepEqual(p.navigations,[url]);
  assert.equal(p.button.disabled,true);
});
test('login failure stays on page and enables retry', async () => {
  const p = page(() => Response.json({error:'INVALID_ORIGIN'},{status:403}));
  await p.element('login').onsubmit({preventDefault() {}});
  assert.deepEqual(p.navigations,[]);
  assert.equal(p.button.disabled,false);
  assert.match(p.element('message').textContent,/INVALID_ORIGIN/);
});
