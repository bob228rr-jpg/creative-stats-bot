import assert from "node:assert/strict";
import test from "node:test";
import { extractDomains, normalizeDomain } from "../lib/domain.js";

test("normalizeDomain strips protocol, www, path and punctuation", () => {
  assert.equal(normalizeDomain("https://WWW.ReamAnd.IvyMarket.Space/path?q=1"), "reamand.ivymarket.space");
  assert.equal(normalizeDomain("reamand.ivymarket.space."), "reamand.ivymarket.space");
});

test("normalizeDomain keeps distinct subdomains", () => {
  assert.equal(normalizeDomain("a.example.com"), "a.example.com");
  assert.equal(normalizeDomain("b.example.com"), "b.example.com");
  assert.notEqual(normalizeDomain("a.example.com"), normalizeDomain("b.example.com"));
});

test("extractDomains returns unique domains", () => {
  assert.deepEqual(extractDomains("https://a.example.com/x and a.example.com, b.example.org"), [
    "a.example.com",
    "b.example.org",
  ]);
});
