import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptSecret,
  encryptSecret,
  isPrivateAddress,
  normalizeStoreUrl,
  safeEqual,
} from "../src/security.js";

test("AES-GCM credential encryption round-trips without plaintext leakage", () => {
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptSecret("abcd EFGH ijkl", key);
  assert.equal(encrypted.includes("abcd"), false);
  assert.equal(decryptSecret(encrypted, key), "abcd EFGH ijkl");
  assert.throws(() => decryptSecret(encrypted, Buffer.alloc(32, 8)));
});

test("constant-time comparison handles equal and unequal inputs", () => {
  assert.equal(safeEqual("same", "same"), true);
  assert.equal(safeEqual("same", "different"), false);
});

test("store URL normalization requires public HTTPS by default", () => {
  assert.equal(normalizeStoreUrl("https://Shop.Example.com/store/"), "https://shop.example.com/store");
  assert.throws(() => normalizeStoreUrl("http://shop.example.com"), /HTTPS/);
  assert.throws(() => normalizeStoreUrl("https://127.0.0.1"), /Private/);
  assert.throws(() => normalizeStoreUrl("https://[::1]"), /Private/);
  assert.throws(() => normalizeStoreUrl("https://user:pass@example.com"), /credentials/);
  assert.equal(normalizeStoreUrl("http://localhost:8080", true), "http://localhost:8080");
});

test("private and reserved addresses are recognized", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.1.1",
    "198.51.100.2",
    "203.0.113.8",
    "::1",
    "fd00::1",
    "2001:db8::1",
    "::ffff:192.168.1.2",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});
