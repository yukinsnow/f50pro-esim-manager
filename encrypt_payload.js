// UFI API logs commands; encrypt sensitive download inputs for local backend.
(()=>{
window.__f50EncryptPayload=async(input)=>{
 const r=await runShellWithRoot('/data/adb/f50-esim/manager.sh status',15000);
 if(!r.success)throw Error('无法获取本机加密公钥');let s=String(r.content);let d=JSON.parse(s.slice(s.indexOf('{')));const k=d.data?.publicKey;if(!k?.n||!k.e)throw Error('本机加密公钥未就绪');
 if(typeof BigInt!=='function'||!window.crypto?.getRandomValues)throw Error('此浏览器缺少安全加密能力，拒绝明文发送激活码');
 const n=BigInt('0x'+k.n),e=BigInt(k.e),size=Math.ceil(k.n.length/2),raw=new TextEncoder().encode(JSON.stringify(input));let chunks=[];
 function pow(a,b,m){let x=1n;while(b){if(b&1n)x=x*a%m;a=a*a%m;b>>=1n}return x}
 for(let offset=0;offset<raw.length;offset+=size-11){let msg=raw.slice(offset,offset+size-11),pad=new Uint8Array(size-msg.length-3);crypto.getRandomValues(pad);for(let i=0;i<pad.length;i++)while(pad[i]===0){let t=new Uint8Array(1);crypto.getRandomValues(t);pad[i]=t[0]}let block=new Uint8Array(size);block[1]=2;block.set(pad,2);block.set(msg,size-msg.length);let x=BigInt('0x'+Array.from(block,b=>b.toString(16).padStart(2,'0')).join(''));let h=pow(x,e,n).toString(16).padStart(size*2,'0');let b=Uint8Array.from(h.match(/../g),v=>parseInt(v,16));chunks.push(btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''))}
 return 'enc1.'+chunks.join('.');
};
})();
