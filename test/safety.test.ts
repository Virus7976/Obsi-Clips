import { test } from "node:test";
import assert from "node:assert/strict";
import { addressProblem } from "../src/safety";

test("A key goes only over https or to this device", () => {
	assert.equal(addressProblem("https://openrouter.ai/api/v1", true), null);
	assert.equal(addressProblem("http://127.0.0.1:47391/v1", true), null);
	assert.equal(addressProblem("http://localhost:11434/v1", true), null);
	assert.match(addressProblem("http://192.168.1.20:11434/v1", true) ?? "", /https/);
	assert.match(addressProblem("http://api.example.com/v1", true) ?? "", /https/);
});

test("Plain http without a key: this device and the home network only", () => {
	assert.equal(addressProblem("http://192.168.1.20:11434/v1", false), null);
	assert.equal(addressProblem("http://10.0.0.5:1234/v1", false), null);
	assert.equal(addressProblem("http://desktop.local:11434/v1", false), null);
	assert.notEqual(addressProblem("http://api.example.com/v1", false), null);
	assert.notEqual(addressProblem("http://172.32.0.1/v1", false), null);
});

test("Odd addresses are refused", () => {
	assert.notEqual(addressProblem("ftp://example.com", false), null);
	assert.notEqual(addressProblem("not a url", false), null);
	assert.match(addressProblem("https://user:secret@example.com/v1", false) ?? "", /Key box/);
	// A look-alike name is not this device.
	assert.notEqual(addressProblem("http://127.0.0.1.evil.com/v1", true), null);
});
