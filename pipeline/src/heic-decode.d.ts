/**
 * Ambient types for `heic-decode`, which ships no declarations.
 *
 * The package is plain CommonJS (`module.exports = one`), so a default import
 * with `esModuleInterop` is what the runtime sees too.
 */
declare module "heic-decode" {
  interface HeicDecodeOptions {
    buffer: Uint8Array | ArrayBuffer;
    /** Which image in a multi-image file; defaults to the first. */
    image?: number;
  }
  interface HeicImage {
    width: number;
    height: number;
    /** RGBA pixels, in the shape of an `ImageData`. */
    data: Uint8ClampedArray;
  }
  function heicDecode(options: HeicDecodeOptions): Promise<HeicImage>;
  namespace heicDecode {
    function all(options: HeicDecodeOptions): Promise<{ decode(): Promise<HeicImage>; dispose(): void }[]>;
  }
  export = heicDecode;
}
