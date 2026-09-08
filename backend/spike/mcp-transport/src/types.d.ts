/** Wrangler's `Data` module rule (wrangler.toml `[[rules]]`) imports a
 *  matched binary file as an `ArrayBuffer` default export. */
declare module "*.bin" {
  const value: ArrayBuffer;
  export default value;
}
