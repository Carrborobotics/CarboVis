// ===== field layout shared by the simulated robot and the demo matches (fakematch.js) =====
const Sample = (() => {
  // Rough 2026 field AprilTags for the made-up cameras (sample log and simulated match): [id, x m, y m, facing°].
  // One tag on each face of both hubs, four on each alliance wall and a few on the side walls. Not the official layout.
  const FIELD_TAGS = [
    [2, 11.31, 4.03, 180], [3, 11.9, 4.63, 90], [4, 12.49, 4.03, 0], [5, 11.9, 3.43, -90],
    [18, 5.19, 4.03, 0], [19, 4.6, 4.63, 90], [20, 4.01, 4.03, 180], [21, 4.6, 3.43, -90],
    [13, 16.52, 0.65, 180], [14, 16.52, 3.4, 180], [15, 16.52, 4.67, 180], [16, 16.52, 7.4, 180],
    [29, 0.02, 0.65, 0], [30, 0.02, 3.4, 0], [31, 0.02, 4.67, 0], [32, 0.02, 7.4, 0],
    [6, 11.9, 0.02, 90], [7, 11.9, 8.05, -90], [8, 8.27, 0.02, 90], [9, 8.27, 8.05, -90],
    [22, 4.6, 0.02, 90], [23, 4.6, 8.05, -90],
  ];
  // Camera mounts, as the robot logs them in Vision/<cam>/RobotToCamera: [x fwd m, y left m, z m, roll°, pitch°, yaw°]
  const CAM_MOUNTS = { FrontLeft: [0.27, 0.27, 0.22, 0, -20, 30], BackRight: [-0.27, -0.27, 0.22, 0, -20, -150] };
  // Tags a camera on a robot at (x, y, heading rad) can see, nearest first: [{ id, yaw° (+ = left), dist m }]
  function tagsSeen(rx, ry, rh, mount, fovDeg = 70, maxM = 7.5) {
    const c = Math.cos(rh), s = Math.sin(rh);
    const cx = rx + c * mount[0] - s * mount[1], cy = ry + s * mount[0] + c * mount[1], ch = rh + mount[5] * Math.PI / 180;
    const out = [];
    for (const [id, tx, ty, f] of FIELD_TAGS) {
      const dx = tx - cx, dy = ty - cy, d = Math.hypot(dx, dy);
      if (d > maxM || d < 0.3) continue;
      let b = Math.atan2(dy, dx) - ch; b = Math.atan2(Math.sin(b), Math.cos(b)) * 180 / Math.PI;
      if (Math.abs(b) > fovDeg / 2) continue;
      const fr = f * Math.PI / 180;
      if ((-dx * Math.cos(fr) - dy * Math.sin(fr)) / d < 0.3) continue; // seen from behind or nearly edge-on
      out.push({ id, yaw: b, dist: d });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  return { tagsSeen, CAM_MOUNTS, FIELD_TAGS };
})();
if (typeof module !== 'undefined') module.exports = Sample;
