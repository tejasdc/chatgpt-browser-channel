export function record(value:unknown):value is Record<string,unknown> {
 return typeof value==='object' && value!==null && !Array.isArray(value);
}
export function field(value:unknown,key:string):unknown {return record(value)?value[key]:undefined;}
export function stringField(value:unknown,key:string):string|null {
 const result=field(value,key);return typeof result==='string'?result:null;
}
export function arrayField(value:unknown,key:string):readonly unknown[] {
 const result=field(value,key);return Array.isArray(result)?result:[];
}
export function parseJson(value:string):unknown {return JSON.parse(value) as unknown;}
