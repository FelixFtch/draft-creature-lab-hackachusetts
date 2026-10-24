// Scene-graph verification only. Canvas drawing is stubbed; this is not a render
// or VLM-visibility test. Actual camera before/after evidence belongs in Chrome.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as THREE from '../play/node_modules/three/build/three.module.js';
import {createTrailVisuals} from '../play/src/trail-visuals.js';
import {createTrail} from '../play/src/trail-game.js';
const ctx={beginPath(){},arc(){},fill(){},stroke(){},fillText(){}};
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>ctx})};
const scene=new THREE.Scene(),visuals=createTrailVisuals(scene),group=scene.children[0];
const markers=group.children.filter(node=>node.isGroup);
const signs=markers.map(node=>node.children.find(child=>child.isSprite));
const stems=markers.map(node=>node.children.find(child=>child.geometry?.type==='CylinderGeometry'));
const rings=markers.map(node=>node.children.find(child=>child.geometry?.type==='RingGeometry'));
const report={createdAt:new Date().toISOString(),scope:'Production Three.js scene-graph properties with a stub canvas; no actual rasterization, browser, physical collision or VLM inference.',checks:[]};
function check(name,run){try{run();report.checks.push({name,pass:true});}catch(e){report.checks.push({name,pass:false,error:e.message});}}
check('Three numbered signs are initially visible in a new trail',()=>{visuals.update(createTrail());assert.equal(markers.length,3);assert(group.visible);assert(signs.every(x=>x.visible));assert(stems.every(x=>x.visible));});
check('Active and future signs use compact global scales without changing floor goals',()=>{visuals.update(createTrail());assert.deepEqual(signs.map(x=>x.scale.x),[.18,.15,.15]);assert.deepEqual(signs.map(x=>x.scale.y),[.18,.15,.15]);assert(rings.every(x=>x.geometry.parameters.outerRadius===.45));visuals.update({...createTrail(),collected:1});assert.deepEqual(signs.map(x=>x.scale.x),[.15,.18,.15]);visuals.update({...createTrail(),collected:2});assert.deepEqual(signs.map(x=>x.scale.x),[.15,.15,.18]);});
check('After first goal, only its sign and stem retire; the green floor ring remains',()=>{visuals.update({...createTrail(),collected:1});assert.equal(signs[0].visible,false);assert.equal(stems[0].visible,false);assert.equal(rings[0].visible,true);assert.equal(rings[0].material.color.getHexString(),'397966');assert(signs.slice(1).every(x=>x.visible));assert(stems.slice(1).every(x=>x.visible));});
check('After second goal, the third sign remains visible',()=>{visuals.update({...createTrail(),collected:2});assert.deepEqual(signs.map(x=>x.visible),[false,false,true]);assert.deepEqual(stems.map(x=>x.visible),[false,false,true]);});
check('Completed course retains all floor rings and no occluding billboards',()=>{visuals.update({...createTrail(),collected:3,phase:'complete'});assert(signs.every(x=>!x.visible));assert(stems.every(x=>!x.visible));assert(rings.every(x=>x.visible&&x.material.color.getHexString()==='397966'));});
check('Starting another round restores every numbered sign and stem',()=>{visuals.update(createTrail());assert(signs.every(x=>x.visible));assert(stems.every(x=>x.visible));});
check('Leaving the trail hides its complete scene group',()=>{visuals.update(null);assert.equal(group.visible,false);});
visuals.dispose();report.pass=report.checks.every(x=>x.pass);
report.sourceSha256=crypto.createHash('sha256').update(await fs.readFile(new URL('../play/src/trail-visuals.js',import.meta.url))).digest('hex');
await fs.writeFile(new URL('./trail-visuals-validation.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1;
