import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { encode, decodeMulti } from '@msgpack/msgpack';
window.Vendor = { THREE, GLTFLoader, STLLoader, OrbitControls, mergeVertices, msgpack: { encode, decodeMulti } };
