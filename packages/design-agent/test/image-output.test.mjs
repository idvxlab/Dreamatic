import assert from "node:assert/strict";
import test from "node:test";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { encodeImageOutput, imageEncoding, imageOutputFormat } from "../dist/image-output.js";
const PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64");
test("image encodings match agreed PNG/JPG/JPEG paths without resizing or re-encoding matching bytes",()=>{
  for(const extension of [".jpg",".jpeg",".JPG"]) {
    const result=encodeImageOutput(PNG,"artifacts/image"+extension);
    assert.equal(imageEncoding(result.bytes),"jpeg");assert.equal(result.mimeType,"image/jpeg");
    const decoded=PhotonImage.new_from_byteslice(result.bytes);
    try {assert.equal(decoded.get_width(),1);assert.equal(decoded.get_height(),1);}finally{decoded.free();}
    assert.equal(encodeImageOutput(result.bytes,"artifacts/other.jpeg").bytes,result.bytes);
    assert.equal(imageEncoding(encodeImageOutput(result.bytes,"artifacts/other.png").bytes),"png");
  }
  assert.equal(encodeImageOutput(PNG,"artifacts/default.png").bytes,PNG);
  assert.equal(imageOutputFormat("artifacts/image.PNG"),"png");
});
test("unsupported output encodings and nonimage provider bytes are rejected without disguising their format",()=>{
  assert.throws(()=>imageOutputFormat("artifacts/image.webp"),/unsupported extension/);
  assert.throws(()=>encodeImageOutput(Buffer.from("not an image"),"artifacts/image.jpg"),/unsupported image bytes/);
});
