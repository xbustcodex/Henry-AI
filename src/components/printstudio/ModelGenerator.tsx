/**
 * Henry 3D Model Generator
 * Photo/measurement intake → Claude vision analysis → real STL/3MF generation
 * Uses a parametric geometry engine — correct real-world millimeter dimensions
 */

import { useState, useRef, useCallback } from 'react';
import { useStore } from '../../store';
import ModelPreview3D from './ModelPreview3D';

interface ModelSpec {
  name: string;
  description: string;
  shapes: ShapeSpec[];
  units: 'mm';
}

interface ShapeSpec {
  type: 'box'|'cylinder'|'sphere'|'cone'|'tube'|'rounded_box'|'torus';
  x?: number; y?: number; z?: number;
  width?: number; height?: number; depth?: number;
  radius?: number; radius2?: number;
  segments?: number; wall?: number;
  operation?: 'add'|'subtract';
  label?: string;
}

// ── Geometry Engine ────────────────────────────────────────────────────────
interface Vec3 { x:number; y:number; z:number }
interface Triangle { a:Vec3; b:Vec3; c:Vec3; normal:Vec3 }

function normalize(v:Vec3):Vec3 {
  const l=Math.sqrt(v.x*v.x+v.y*v.y+v.z*v.z)||1;
  return {x:v.x/l,y:v.y/l,z:v.z/l};
}
function cross(a:Vec3,b:Vec3):Vec3 { return {x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x}; }
function sub(a:Vec3,b:Vec3):Vec3 { return {x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}; }

function triNormal(t:Omit<Triangle,'normal'>):Vec3 { return normalize(cross(sub(t.b,t.a),sub(t.c,t.a))); }
function makeTri(a:Vec3,b:Vec3,c:Vec3):Triangle { const t={a,b,c,normal:{x:0,y:0,z:0}}; t.normal=triNormal(t); return t; }

function genBox(w:number,h:number,d:number,ox=0,oy=0,oz=0):Triangle[] {
  const x1=ox-w/2,x2=ox+w/2,y1=oy-h/2,y2=oy+h/2,z1=oz,z2=oz+d;
  const faces:Triangle[]=[];
  // Bottom
  faces.push(makeTri({x:x1,y:y1,z:z1},{x:x2,y:y1,z:z1},{x:x2,y:y2,z:z1}));
  faces.push(makeTri({x:x1,y:y1,z:z1},{x:x2,y:y2,z:z1},{x:x1,y:y2,z:z1}));
  // Top
  faces.push(makeTri({x:x1,y:y1,z:z2},{x:x2,y:y2,z:z2},{x:x2,y:y1,z:z2}));
  faces.push(makeTri({x:x1,y:y1,z:z2},{x:x1,y:y2,z:z2},{x:x2,y:y2,z:z2}));
  // Front
  faces.push(makeTri({x:x1,y:y1,z:z1},{x:x1,y:y1,z:z2},{x:x2,y:y1,z:z2}));
  faces.push(makeTri({x:x1,y:y1,z:z1},{x:x2,y:y1,z:z2},{x:x2,y:y1,z:z1}));
  // Back
  faces.push(makeTri({x:x1,y:y2,z:z1},{x:x2,y:y2,z:z2},{x:x1,y:y2,z:z2}));
  faces.push(makeTri({x:x1,y:y2,z:z1},{x:x2,y:y2,z:z1},{x:x2,y:y2,z:z2}));
  // Left
  faces.push(makeTri({x:x1,y:y1,z:z1},{x:x1,y:y2,z:z2},{x:x1,y:y2,z:z1}));
  faces.push(makeTri({x:x1,y:y1,z:z1},{x:x1,y:y1,z:z2},{x:x1,y:y2,z:z2}));
  // Right
  faces.push(makeTri({x:x2,y:y1,z:z1},{x:x2,y:y2,z:z1},{x:x2,y:y2,z:z2}));
  faces.push(makeTri({x:x2,y:y1,z:z1},{x:x2,y:y2,z:z2},{x:x2,y:y1,z:z2}));
  return faces;
}

function genCylinder(r:number,h:number,segs=32,ox=0,oy=0,oz=0,r2?:number):Triangle[] {
  const tris:Triangle[]=[];
  const topR=r2??r;
  for(let i=0;i<segs;i++){
    const a0=2*Math.PI*i/segs, a1=2*Math.PI*(i+1)/segs;
    const bx0=ox+r*Math.cos(a0),by0=oy+r*Math.sin(a0);
    const bx1=ox+r*Math.cos(a1),by1=oy+r*Math.sin(a1);
    const tx0=ox+topR*Math.cos(a0),ty0=oy+topR*Math.sin(a0);
    const tx1=ox+topR*Math.cos(a1),ty1=oy+topR*Math.sin(a1);
    // Side
    tris.push(makeTri({x:bx0,y:by0,z:oz},{x:bx1,y:by1,z:oz},{x:tx0,y:ty0,z:oz+h}));
    tris.push(makeTri({x:bx1,y:by1,z:oz},{x:tx1,y:ty1,z:oz+h},{x:tx0,y:ty0,z:oz+h}));
    // Bottom cap
    tris.push(makeTri({x:ox,y:oy,z:oz},{x:bx1,y:by1,z:oz},{x:bx0,y:by0,z:oz}));
    // Top cap
    tris.push(makeTri({x:ox,y:oy,z:oz+h},{x:tx0,y:ty0,z:oz+h},{x:tx1,y:ty1,z:oz+h}));
  }
  return tris;
}

function genTorus(r:number,tube:number,segs=32,tubeSegs=16,ox=0,oy=0,oz=0):Triangle[] {
  const tris:Triangle[]=[];
  for(let i=0;i<segs;i++){
    for(let j=0;j<tubeSegs;j++){
      const a0=2*Math.PI*i/segs,a1=2*Math.PI*(i+1)/segs;
      const b0=2*Math.PI*j/tubeSegs,b1=2*Math.PI*(j+1)/tubeSegs;
      const v=(pts:[number,number][])=>pts.map(([a,b])=>({
        x:ox+(r+tube*Math.cos(b))*Math.cos(a),
        y:oy+(r+tube*Math.cos(b))*Math.sin(a),
        z:oz+tube*Math.sin(b)
      }));
      const [p0,p1,p2,p3]=v([[a0,b0],[a1,b0],[a1,b1],[a0,b1]]);
      tris.push(makeTri(p0,p1,p2)); tris.push(makeTri(p0,p2,p3));
    }
  }
  return tris;
}

function genSphere(r:number,segs=24,ox=0,oy=0,oz=0):Triangle[] {
  const tris:Triangle[]=[];
  for(let i=0;i<segs;i++){
    for(let j=0;j<segs;j++){
      const lat0=Math.PI*(i/segs-0.5), lat1=Math.PI*((i+1)/segs-0.5);
      const lon0=2*Math.PI*j/segs, lon1=2*Math.PI*(j+1)/segs;
      const v=([[lat0,lon0],[lat0,lon1],[lat1,lon1],[lat1,lon0]] as [number,number][]).map(([la,lo])=>({
        x:ox+r*Math.cos(la)*Math.cos(lo),y:oy+r*Math.cos(la)*Math.sin(lo),z:oz+r*Math.sin(la)
      }));
      tris.push(makeTri(v[0],v[1],v[2]));
      tris.push(makeTri(v[0],v[2],v[3]));
    }
  }
  return tris;
}

function specToTriangles(spec:ModelSpec):Triangle[] {
  const all:Triangle[]=[];
  for(const s of spec.shapes){
    if(s.operation==='subtract') continue; // skip subtracts — visual only for now
    const ox=s.x||0, oy=s.y||0, oz=s.z||0;
    const segs=s.segments||48;
    if(s.type==='box'||s.type==='rounded_box') {
      all.push(...genBox(s.width||10,s.depth||10,s.height||10,ox,oy,oz));
    } else if(s.type==='cylinder') {
      all.push(...genCylinder(s.radius||5,s.height||10,segs,ox,oy,oz));
    } else if(s.type==='tube') {
      // Hollow cylinder: outer - inner (approximate with two cylinders, just show outer for preview)
      const outer=s.radius||10;
      const inner=outer-(s.wall||2);
      all.push(...genCylinder(outer,s.height||10,segs,ox,oy,oz));
      // For STL we also need the inner surface and caps — simplified here
      if(inner>0) all.push(...genCylinder(inner,s.height||10,segs,ox,oy,oz));
    } else if(s.type==='sphere') {
      all.push(...genSphere(s.radius||5,s.segments||32,ox,oy,oz));
    } else if(s.type==='cone') {
      all.push(...genCylinder(s.radius||5,s.height||10,segs,ox,oy,oz,s.radius2||0));
    } else if(s.type==='torus') {
      all.push(...genTorus(s.radius||15,s.wall||4,segs,16,ox,oy,oz));
    }
  }
  return all;
}

// ── STL Export ─────────────────────────────────────────────────────────────
function toSTL(tris:Triangle[], name:string):Uint8Array {
  const buf=new ArrayBuffer(80+4+tris.length*50);
  const view=new DataView(buf);
  const enc=new TextEncoder();
  const header=enc.encode(name.padEnd(80,' ').slice(0,80));
  new Uint8Array(buf).set(header,0);
  view.setUint32(80,tris.length,true);
  tris.forEach((t,i)=>{
    const off=84+i*50;
    view.setFloat32(off+0,t.normal.x,true);view.setFloat32(off+4,t.normal.y,true);view.setFloat32(off+8,t.normal.z,true);
    view.setFloat32(off+12,t.a.x,true);view.setFloat32(off+16,t.a.y,true);view.setFloat32(off+20,t.a.z,true);
    view.setFloat32(off+24,t.b.x,true);view.setFloat32(off+28,t.b.y,true);view.setFloat32(off+32,t.b.z,true);
    view.setFloat32(off+36,t.c.x,true);view.setFloat32(off+40,t.c.y,true);view.setFloat32(off+44,t.c.z,true);
    view.setUint16(off+48,0,true);
  });
  return new Uint8Array(buf);
}

// ── 3MF Export ─────────────────────────────────────────────────────────────
function to3MF(tris:Triangle[], name:string):string {
  const verts:Vec3[]=[];
  const vMap=new Map<string,number>();
  const triIdxs:{a:number;b:number;c:number}[]=[];
  for(const t of tris){
    const vi=[t.a,t.b,t.c].map(v=>{
      const k=`${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
      if(!vMap.has(k)){vMap.set(k,verts.length);verts.push(v);}
      return vMap.get(k)!;
    });
    triIdxs.push({a:vi[0],b:vi[1],c:vi[2]});
  }
  const vs=verts.map(v=>`      <vertex x="${v.x.toFixed(4)}" y="${v.y.toFixed(4)}" z="${v.z.toFixed(4)}"/>`).join('\n');
  const ts=triIdxs.map(t=>`      <triangle v1="${t.a}" v2="${t.b}" v3="${t.c}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">${name}</metadata>
  <metadata name="Application">Henry AI 3D Studio</metadata>
  <resources>
    <object id="1" name="${name}" type="model">
      <mesh>
        <vertices>
${vs}
        </vertices>
        <triangles>
${ts}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1"/>
  </build>
</model>`;
}

function downloadBlob(data:Uint8Array<ArrayBufferLike>|string, name:string, mime:string){
  const blob=new Blob([data as BlobPart],{type:mime});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

// ── AI Analysis ────────────────────────────────────────────────────────────
async function analyzeWithAI(description:string, imageB64:string|null, apiKey:string, model='claude-sonnet-4-20250514'):Promise<ModelSpec>{
  const content:any[]=[
    ...(imageB64?[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:imageB64}}]:[]),
    {type:'text',text:`You are a 3D CAD engineer. Generate a ModelSpec JSON for 3D printing.

User request: ${description}

Return ONLY valid JSON matching this TypeScript type:
interface ModelSpec {
  name: string;           // short name for the file
  description: string;    // what it is
  shapes: Array<{
    type: 'box'|'cylinder'|'sphere'|'cone'|'rounded_box'|'tube'|'torus';
    label?: string;
    x?: number; y?: number; z?: number;  // offset position in mm
    width?: number; height?: number; depth?: number;  // for box types
    radius?: number; radius2?: number;   // for cylinder/cone/sphere
    height?: number;                     // for cylinder/cone
    segments?: number;                   // polygon detail, default 48
    wall?: number;                       // for tube wall thickness
    operation?: 'add'|'subtract';
  }>;
  units: 'mm';
}

Rules:
- ALL dimensions in MILLIMETERS, real-world accurate
- Use standard measurements (e.g. phone ~75mm wide, coffee mug ~80mm dia × 95mm tall)
- If user gives measurements, use them exactly
- Use multiple shapes to build complex objects
- Minimum wall thickness 1.2mm for printability
- Return ONLY the JSON object, no markdown`}
  ];

  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','anthropic-version':'2023-06-01'},
    body:JSON.stringify({model,max_tokens:1500,messages:[{role:'user',content}]})
  });
  if(!res.ok) throw new Error('AI request failed: '+res.status);
  const data=await res.json() as {content:{type:string;text:string}[]};
  const text=data.content.find(c=>c.type==='text')?.text||'{}';
  const clean=text.replace(/```json|```/g,'').trim();
  return JSON.parse(clean) as ModelSpec;
}

// ── Component ──────────────────────────────────────────────────────────────
export default function ModelGenerator(){
  const { providers } = useStore();
  const [step, setStep]         = useState<'intake'|'analyzing'|'preview'|'error'>('intake');
  const [description, setDesc]  = useState('');
  const [imageB64, setImageB64] = useState<string|null>(null);
  const [imagePreview, setImgPrev]=useState<string|null>(null);
  const [spec, setSpec]         = useState<ModelSpec|null>(null);
  const [tris, setTris]         = useState<Triangle[]>([]);
  const [error, setError]       = useState('');
  const [editSpec, setEditSpec] = useState('');
  const [dims, setDims]         = useState({w:'',h:'',d:'',r:''});
  const fileRef=useRef<HTMLInputElement>(null);

  const anthropicKey = providers?.find((p:any)=>p.id==='anthropic')?.apiKey || '';

  function handleFile(file:File){
    const reader=new FileReader();
    reader.onload=e=>{
      const url=e.target?.result as string;
      setImgPrev(url);
      setImageB64(url.split(',')[1]);
    };
    reader.readAsDataURL(file);
  }

  const onDrop=useCallback((e:React.DragEvent)=>{
    e.preventDefault();
    const f=e.dataTransfer.files[0];
    if(f&&f.type.startsWith('image/')) handleFile(f);
  },[]);

  async function generate(){
    if(!description.trim()&&!imageB64){ setError('Add a description or photo.'); return; }
    setStep('analyzing'); setError('');
    try {
      // Build description with any manual dimensions
      let fullDesc=description;
      if(dims.w||dims.h||dims.d||dims.r){
        const dimParts=[];
        if(dims.w) dimParts.push(`width=${dims.w}mm`);
        if(dims.h) dimParts.push(`height=${dims.h}mm`);
        if(dims.d) dimParts.push(`depth=${dims.d}mm`);
        if(dims.r) dimParts.push(`radius=${dims.r}mm`);
        fullDesc+=` Dimensions: ${dimParts.join(', ')}.`;
      }

      let modelSpec:ModelSpec;
      if(anthropicKey){
        modelSpec=await analyzeWithAI(fullDesc,imageB64,anthropicKey);
      } else {
        // Fallback: generate basic model from description keywords
        modelSpec=fallbackSpec(fullDesc,dims);
      }

      const triangles=specToTriangles(modelSpec);
      setSpec(modelSpec);
      setEditSpec(JSON.stringify(modelSpec,null,2));
      setTris(triangles);
      setStep('preview');
    } catch(e){
      setError('Generation failed: '+(e instanceof Error?e.message:String(e)));
      setStep('error');
    }
  }

  function regenerateFromSpec(){
    try {
      const parsed=JSON.parse(editSpec) as ModelSpec;
      setSpec(parsed);
      setTris(specToTriangles(parsed));
    } catch(e){ setError('Invalid JSON: '+String(e)); }
  }

  function dlSTL(){
    if(!tris.length||!spec) return;
    downloadBlob(toSTL(tris,spec.name),spec.name.replace(/\s+/g,'_')+'.stl','application/octet-stream');
  }

  function dl3MF(){
    if(!tris.length||!spec) return;
    downloadBlob(to3MF(tris,spec.name),spec.name.replace(/\s+/g,'_')+'.3mf','application/octet-stream');
  }

  const triCount=tris.length;
  const inputCls="w-full bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-colors";

  return(
    <div className="flex flex-col h-full bg-henry-bg overflow-y-auto">
      <div className="px-6 pt-5 pb-3 border-b border-henry-border/20 flex-shrink-0">
        <h2 className="text-base font-bold text-henry-text">3D Model Generator</h2>
        <p className="text-[11px] text-henry-text-muted mt-0.5">Describe or photograph anything → download real STL / 3MF</p>
      </div>

      <div className="flex-1 px-6 py-5 space-y-5 max-w-2xl">
        {!anthropicKey && (
          <div className="bg-yellow-400/10 border border-yellow-400/30 rounded-xl px-4 py-3">
            <p className="text-[12px] text-yellow-400">⚠ Add an Anthropic API key in Settings → AI Providers for photo analysis. Without it, basic shape generation still works.</p>
          </div>
        )}

        {/* Intake */}
        <div className="space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-1 block">Describe what to make</label>
            <textarea value={description} onChange={e=>setDesc(e.target.value)} rows={3}
              placeholder="e.g. 'phone stand 75mm wide 130mm tall angled 30 degrees' or 'replacement bracket for my desk lamp'"
              className={inputCls+' resize-none'} />
          </div>

          {/* Dimensions */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-1 block">Measurements (mm) — optional if described above</label>
            <div className="grid grid-cols-4 gap-2">
              {[['w','Width'],['h','Height'],['d','Depth'],['r','Radius']].map(([k,l])=>(
                <input key={k} type="number" step="0.1" placeholder={l} value={(dims as any)[k]}
                  onChange={e=>setDims(d=>({...d,[k]:e.target.value}))}
                  className="bg-henry-surface border border-henry-border/30 rounded-lg px-2 py-1.5 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 text-center" />
              ))}
            </div>
          </div>

          {/* Photo drop zone */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-1 block">Photo of object (optional — Claude analyzes shape)</label>
            <div onDrop={onDrop} onDragOver={e=>e.preventDefault()}
              onClick={()=>fileRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all hover:border-henry-accent/50 ${imagePreview?'border-henry-accent/40':'border-henry-border/30'}`}>
              {imagePreview ? (
                <div className="flex items-center gap-3">
                  <img src={imagePreview} className="w-16 h-16 object-cover rounded-lg flex-shrink-0" />
                  <div className="text-left">
                    <p className="text-sm text-henry-text font-medium">Photo loaded ✓</p>
                    <p className="text-[11px] text-henry-text-muted">Claude will analyze shape and dimensions</p>
                    <button onClick={e=>{e.stopPropagation();setImageB64(null);setImgPrev(null);}} className="text-[10px] text-red-400 hover:underline mt-1">Remove</button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-2xl mb-1">📸</p>
                  <p className="text-sm text-henry-text-muted">Drop a photo or click to upload</p>
                  <p className="text-[11px] text-henry-text-muted/60 mt-0.5">Claude analyzes object shape to generate accurate 3D model</p>
                </>
              )}
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e=>{ const f=e.target.files?.[0]; if(f) handleFile(f); }} />
            </div>
          </div>

          <button onClick={generate} disabled={step==='analyzing'}
            className="w-full py-3 rounded-xl bg-henry-accent text-white font-bold text-sm hover:bg-henry-accent/80 disabled:opacity-40 transition-all">
            {step==='analyzing'?'Analyzing & generating 3D model…':'🔧 Generate 3D Model'}
          </button>
        </div>

        {error && <div className="bg-red-400/10 border border-red-400/30 rounded-xl px-4 py-3 text-sm text-red-400">{error}</div>}

        {/* Preview + Download */}
        {step==='preview' && spec && (
          <div className="space-y-4">
            {/* 3D Preview */}
        <ModelPreview3D triangles={tris} name={spec.name} className="h-72" />

        <div className="bg-henry-surface rounded-xl border border-henry-border/20 p-4">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="font-bold text-henry-text">{spec.name}</p>
                  <p className="text-[11px] text-henry-text-muted mt-0.5">{spec.description}</p>
                  <p className="text-[10px] text-henry-text-muted/60 mt-1">{triCount.toLocaleString()} triangles · millimeter scale</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={dlSTL} className="px-4 py-2 rounded-xl bg-henry-accent text-white text-sm font-bold hover:bg-henry-accent/80 transition-all">⬇ STL</button>
                  <button onClick={dl3MF} className="px-4 py-2 rounded-xl bg-green-500/20 border border-green-500/30 text-green-400 text-sm font-bold hover:bg-green-500/30 transition-all">⬇ 3MF</button>
                </div>
              </div>
              <div className="text-[11px] text-henry-text-muted space-y-1">
                {spec.shapes.map((s,i)=>(
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-henry-accent">◆</span>
                    <span>{s.label||s.type}: {s.width||s.radius||''}
                      {s.width?`W=${s.width}mm `:''}
                      {s.height?`H=${s.height}mm `:''}
                      {s.depth?`D=${s.depth}mm `:''}
                      {s.radius?`R=${s.radius}mm `:''}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Spec editor */}
            <div>
              <label className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-1 block">Edit model spec (JSON) then regenerate</label>
              <textarea value={editSpec} onChange={e=>setEditSpec(e.target.value)} rows={12}
                className={inputCls+' resize-none font-mono text-xs'} />
              <button onClick={regenerateFromSpec} className="mt-2 text-[11px] px-4 py-1.5 rounded-lg bg-henry-surface border border-henry-border/30 text-henry-text-muted hover:text-henry-accent transition-all">
                ↺ Regenerate from spec
              </button>
            </div>

            <button onClick={()=>{setStep('intake');setSpec(null);setTris([]);}} className="text-[11px] text-henry-text-muted hover:text-henry-text transition-all">
              ← Generate another model
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Fallback spec when no Anthropic key
function fallbackSpec(desc:string, dims:{w:string;h:string;d:string;r:string}):ModelSpec {
  const t=desc.toLowerCase();
  const w=parseFloat(dims.w)||50, h=parseFloat(dims.h)||50, d=parseFloat(dims.d)||50, r=parseFloat(dims.r)||25;

  if(t.includes('cylinder')||t.includes('tube')||t.includes('pipe')||t.includes('cup')||t.includes('mug')){
    return { name:'Cylinder', description:'Cylindrical object', units:'mm', shapes:[{type:'cylinder',radius:r||w/2,height:h,segments:64}] };
  }
  if(t.includes('sphere')||t.includes('ball')||t.includes('dome')){
    return { name:'Sphere', description:'Spherical object', units:'mm', shapes:[{type:'sphere',radius:r||w/2,segments:48}] };
  }
  if(t.includes('cone')||t.includes('pyramid')||t.includes('funnel')){
    return { name:'Cone', description:'Conical object', units:'mm', shapes:[{type:'cone',radius:r||w/2,radius2:0,height:h,segments:48}] };
  }
  // Default: box
  return { name:'Box', description:'Box object', units:'mm', shapes:[{type:'box',width:w,height:h,depth:d}] };
}
