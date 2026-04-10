/**
 * parse-branches.js
 *
 * Parses SVG files containing hand-drawn vine branch paths,
 * extracts branch path coordinates, and converts them to world coordinates.
 *
 * Usage: node parse-branches.js
 */

import { readFileSync } from 'fs';

// --- Configuration ---
const SPINE_CENTER_X = 966;     // pixel X of spine center
const SPINE_TOP_Y = 170;        // pixel Y of spine top
const SPINE_BOTTOM_Y = 1210;    // pixel Y of spine bottom
const WORLD_HEIGHT = 4.72;      // total world height (2.36 * 2)
const WORLD_TOP_Y = 2.36;       // worldY at spine top

const SCALE = (SPINE_BOTTOM_Y - SPINE_TOP_Y) / WORLD_HEIGHT; // pixels per world unit
const SAMPLE_INTERVAL = 50;     // sample every ~50 pixels along curves

// --- Coordinate conversion ---
function pixelToWorld(px, py) {
  const wx = (px - SPINE_CENTER_X) / SCALE;
  const wy = WORLD_TOP_Y - (py - SPINE_TOP_Y) / SCALE;
  return [Math.round(wx * 1000) / 1000, Math.round(wy * 1000) / 1000];
}

// --- SVG Path Parsing ---

/**
 * Tokenize an SVG path d attribute into commands with their parameters
 */
function parseSVGPath(d) {
  const commands = [];
  // Match command letter followed by its numeric arguments
  const re = /([MmLlHhVvCcSsQqTtAaZz])\s*([-\d.,eE\s]*)/g;
  let match;
  while ((match = re.exec(d)) !== null) {
    const cmd = match[1];
    const argsStr = match[2].trim();
    let args = [];
    if (argsStr.length > 0) {
      // Split on whitespace or commas, handling negative numbers
      args = argsStr.match(/-?\d+\.?\d*(?:[eE][+-]?\d+)?/g);
      if (args) {
        args = args.map(Number);
      } else {
        args = [];
      }
    }
    commands.push({ cmd, args });
  }
  return commands;
}

/**
 * Cubic bezier point at parameter t
 */
function cubicBezierPoint(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y, t) {
  const u = 1 - t;
  const x = u*u*u*p0x + 3*u*u*t*p1x + 3*u*t*t*p2x + t*t*t*p3x;
  const y = u*u*u*p0y + 3*u*u*t*p1y + 3*u*t*t*p2y + t*t*t*p3y;
  return [x, y];
}

/**
 * Approximate length of a cubic bezier segment (chord length for quick estimate)
 */
function cubicBezierLength(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y) {
  // Use a subdivision approach for reasonable accuracy
  let len = 0;
  const steps = 20;
  let [prevX, prevY] = [p0x, p0y];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = cubicBezierPoint(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y, t);
    len += Math.sqrt((x - prevX)**2 + (y - prevY)**2);
    prevX = x;
    prevY = y;
  }
  return len;
}

/**
 * Convert parsed SVG path commands into a list of sampled pixel points.
 * Returns array of [x, y] pairs.
 */
function samplePath(commands) {
  const points = [];
  let curX = 0, curY = 0;
  let startX = 0, startY = 0;

  for (const { cmd, args } of commands) {
    switch (cmd) {
      case 'M': {
        // MoveTo absolute - may contain implicit LineTo pairs after first pair
        for (let i = 0; i < args.length; i += 2) {
          curX = args[i];
          curY = args[i + 1];
          if (i === 0) {
            startX = curX;
            startY = curY;
          }
          points.push([curX, curY]);
        }
        break;
      }
      case 'L': {
        // LineTo absolute
        for (let i = 0; i < args.length; i += 2) {
          const toX = args[i];
          const toY = args[i + 1];
          const dist = Math.sqrt((toX - curX)**2 + (toY - curY)**2);
          const numSamples = Math.max(1, Math.floor(dist / SAMPLE_INTERVAL));
          for (let s = 1; s <= numSamples; s++) {
            const t = s / numSamples;
            points.push([
              curX + (toX - curX) * t,
              curY + (toY - curY) * t
            ]);
          }
          curX = toX;
          curY = toY;
        }
        break;
      }
      case 'C': {
        // Cubic bezier absolute - 6 args per curve (cp1x, cp1y, cp2x, cp2y, x, y)
        for (let i = 0; i < args.length; i += 6) {
          const cp1x = args[i], cp1y = args[i+1];
          const cp2x = args[i+2], cp2y = args[i+3];
          const toX = args[i+4], toY = args[i+5];

          const len = cubicBezierLength(curX, curY, cp1x, cp1y, cp2x, cp2y, toX, toY);
          const numSamples = Math.max(1, Math.floor(len / SAMPLE_INTERVAL));

          for (let s = 1; s <= numSamples; s++) {
            const t = s / numSamples;
            const [x, y] = cubicBezierPoint(curX, curY, cp1x, cp1y, cp2x, cp2y, toX, toY, t);
            points.push([x, y]);
          }

          curX = toX;
          curY = toY;
        }
        break;
      }
      case 'Z':
      case 'z': {
        // Close path - line back to start
        curX = startX;
        curY = startY;
        break;
      }
      default:
        // Skip unsupported commands
        break;
    }
  }

  return points;
}

/**
 * Extract all <path> elements from an SVG string, along with their parent <g> stroke info
 */
function extractPaths(svgContent) {
  const paths = [];
  // Match each <g ...><path d="..."/> group
  const gRegex = /<g\s+([^>]*)>\s*<path\s+d="([^"]*(?:"[^"]*)*?)"\s*\/?\s*>/gs;
  // Actually, the path data may span multiple lines. Let's use a different approach.

  // Split by <g to get each group
  const groups = svgContent.split(/<g\s+/);

  for (let i = 1; i < groups.length; i++) {
    const group = groups[i];

    // Extract group attributes
    const fillMatch = group.match(/fill="([^"]*)"/);
    const fillOpacityMatch = group.match(/fill-opacity="([^"]*)"/);
    const strokeMatch = group.match(/stroke="([^"]*)"/);
    const strokeOpacityMatch = group.match(/stroke-opacity="([^"]*)"/);

    const fill = fillMatch ? fillMatch[1] : '';
    const fillOpacity = fillOpacityMatch ? parseFloat(fillOpacityMatch[1]) : 0;
    const stroke = strokeMatch ? strokeMatch[1] : '';
    const strokeOpacity = strokeOpacityMatch ? parseFloat(strokeOpacityMatch[1]) : 0;

    // Extract path d attribute - it may span multiple lines
    const pathMatch = group.match(/<path\s+d="\s*([\s\S]*?)"\s*\/?\s*>/);
    if (!pathMatch) continue;

    const d = pathMatch[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

    paths.push({ fill, fillOpacity, stroke, strokeOpacity, d });
  }

  return paths;
}

/**
 * Check if a path is a background rectangle
 */
function isBackgroundRect(d) {
  // The background rect starts with M 0.00 1333.00 L 1920.00 ...
  return d.startsWith('M 0.00 1333.00') || d.startsWith('M 0 1333');
}

/**
 * Check if a path is primarily along the spine center line (x ~ 960-966)
 */
function isSpineCenterLine(points) {
  if (points.length < 2) return false;

  // Calculate the maximum horizontal deviation from spine center
  let maxDeviation = 0;
  for (const [x, _y] of points) {
    const dev = Math.abs(x - 963); // spine center is roughly between 960-966
    maxDeviation = Math.max(maxDeviation, dev);
  }

  // If max deviation is small, it's the spine center line
  return maxDeviation < 15;
}

/**
 * A path is a "branch" if it extends significantly away from the spine
 */
function isBranchPath(points) {
  if (points.length < 3) return false;

  // Calculate bounding box
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const width = maxX - minX;
  const height = maxY - minY;

  // Must have some spatial extent
  if (width < 20 && height < 20) return false;

  // Must extend at least some distance from spine center
  const maxDeviationFromSpine = Math.max(
    Math.abs(minX - 963),
    Math.abs(maxX - 963)
  );

  if (maxDeviationFromSpine < 20) return false;

  return true;
}

/**
 * An SVG path 'd' attribute may contain multiple sub-paths (multiple M commands).
 * Split them into individual sub-paths.
 */
function splitSubPaths(d) {
  // Split on M commands (but keep the M)
  const subPaths = [];
  const parts = d.split(/(?=M\s)/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      subPaths.push(trimmed);
    }
  }
  return subPaths;
}

// --- Main ---
function main() {
  const files = [
    '/home/user/raina-project/spine-viz/branches/1.svg',
    '/home/user/raina-project/spine-viz/branches/2.svg'
  ];

  const allBranches = [];
  let totalPathsExamined = 0;
  let totalSubPathsExamined = 0;
  let skippedBackground = 0;
  let skippedSpine = 0;
  let skippedSmall = 0;

  for (const file of files) {
    console.error(`\n=== Processing ${file} ===`);
    const svg = readFileSync(file, 'utf-8');
    const paths = extractPaths(svg);
    console.error(`Found ${paths.length} <g>/<path> groups`);

    for (const pathInfo of paths) {
      totalPathsExamined++;

      // Skip invisible groups (opacity 0 or stroke=None with no visible fill)
      // The SVG has: first group = invisible combined outline,
      // then colored stroke groups (the real branches),
      // then colored fill groups (duplicates of the stroke groups)

      // Skip groups with stroke-opacity=0 (invisible outline groups)
      if (pathInfo.strokeOpacity === 0 && pathInfo.fillOpacity === 0) {
        continue;
      }

      // Skip fill-based groups (stroke="None") - these are duplicates of stroke groups
      if (pathInfo.stroke === 'None' || pathInfo.stroke === 'none') {
        continue;
      }

      // Skip very low opacity paths (< 0.05) - basically invisible
      if (pathInfo.strokeOpacity < 0.05 && pathInfo.fillOpacity < 0.05) {
        continue;
      }

      const d = pathInfo.d;

      // Split into sub-paths (each starting with M)
      const subPaths = splitSubPaths(d);

      for (const subD of subPaths) {
        totalSubPathsExamined++;

        // Skip background rectangles
        if (isBackgroundRect(subD)) {
          skippedBackground++;
          continue;
        }

        // Parse and sample the path
        const commands = parseSVGPath(subD);
        const pixelPoints = samplePath(commands);

        if (pixelPoints.length < 3) {
          skippedSmall++;
          continue;
        }

        // Skip spine center lines
        if (isSpineCenterLine(pixelPoints)) {
          skippedSpine++;
          continue;
        }

        // Check if this looks like a branch
        if (!isBranchPath(pixelPoints)) {
          skippedSmall++;
          continue;
        }

        // Convert to world coordinates
        const worldPoints = pixelPoints.map(([px, py]) => pixelToWorld(px, py));

        // Calculate some stats for logging
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        for (const [x, y] of pixelPoints) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }

        const side = (minX + maxX) / 2 > 963 ? 'RIGHT' : 'LEFT';

        console.error(`  Branch: ${side} side, ${worldPoints.length} pts, ` +
          `pixel bbox [${Math.round(minX)},${Math.round(minY)}]-[${Math.round(maxX)},${Math.round(maxY)}], ` +
          `stroke=${pathInfo.stroke} opacity=${pathInfo.strokeOpacity}`);

        allBranches.push(worldPoints);
      }
    }
  }

  console.error(`\n=== Summary ===`);
  console.error(`Total <g> groups examined: ${totalPathsExamined}`);
  console.error(`Total sub-paths examined: ${totalSubPathsExamined}`);
  console.error(`Skipped background: ${skippedBackground}`);
  console.error(`Skipped spine center: ${skippedSpine}`);
  console.error(`Skipped small/non-branch: ${skippedSmall}`);
  console.error(`Branch paths found: ${allBranches.length}`);

  // Now we have many small colored segments. Some may be duplicates (stroke + fill versions).
  // Let's deduplicate by checking if paths share similar start points.
  const dedupedBranches = deduplicateBranches(allBranches);

  console.error(`After deduplication: ${dedupedBranches.length} unique branches`);

  // Output as JavaScript
  console.log('// Auto-generated branch paths from SVG files');
  console.log('// Each branch is an array of [worldX, worldY] pairs');
  console.log('// worldX: 0 = spine center, positive = right, negative = left');
  console.log('// worldY: 2.36 = top of spine, -2.36 = bottom of spine');
  console.log(`// Total branches: ${dedupedBranches.length}`);
  console.log(`// Source: branches/1.svg and branches/2.svg`);
  console.log(`// viewBox: 0 0 1920 1333, spine center pixel: x=${SPINE_CENTER_X}`);
  console.log(`// Conversion: scale=${SCALE.toFixed(2)} px/world-unit`);
  console.log('');
  console.log('const branchPaths = [');

  for (let i = 0; i < dedupedBranches.length; i++) {
    const branch = dedupedBranches[i];

    // Calculate side and vertical range for comment
    let minWX = Infinity, maxWX = -Infinity, minWY = Infinity, maxWY = -Infinity;
    for (const [x, y] of branch) {
      minWX = Math.min(minWX, x);
      maxWX = Math.max(maxWX, x);
      minWY = Math.min(minWY, y);
      maxWY = Math.max(maxWY, y);
    }
    const side = (minWX + maxWX) / 2 > 0 ? 'right' : 'left';

    const pts = branch.map(([x, y]) => `[${x},${y}]`).join(', ');
    const comma = i < dedupedBranches.length - 1 ? ',' : '';
    console.log(`  /* branch ${i}: ${side}, y: ${maxWY.toFixed(2)} to ${minWY.toFixed(2)}, ${branch.length} pts */`);
    console.log(`  [${pts}]${comma}`);
  }

  console.log('];');
  console.log('');
  console.log('export { branchPaths };');
}

/**
 * Deduplicate branches that are essentially the same path drawn twice
 * (once as stroke, once as fill). Check if start/end points are very close.
 */
function deduplicateBranches(branches) {
  if (branches.length === 0) return [];

  const used = new Set();
  const result = [];

  for (let i = 0; i < branches.length; i++) {
    if (used.has(i)) continue;

    const a = branches[i];
    let bestIdx = i;
    let bestLen = a.length;

    // Find duplicates
    for (let j = i + 1; j < branches.length; j++) {
      if (used.has(j)) continue;
      const b = branches[j];

      // Check if start points are close and end points are close
      const startDist = Math.sqrt(
        (a[0][0] - b[0][0])**2 + (a[0][1] - b[0][1])**2
      );
      const endDistA = a[a.length - 1];
      const endDistB = b[b.length - 1];
      const endDist = Math.sqrt(
        (endDistA[0] - endDistB[0])**2 + (endDistA[1] - endDistB[1])**2
      );

      if (startDist < 0.1 && endDist < 0.1) {
        // These are duplicates - keep the one with more points
        used.add(j);
        if (b.length > bestLen) {
          bestIdx = j;
          bestLen = b.length;
        }
      }
    }

    result.push(branches[bestIdx]);
    used.add(bestIdx);
    used.add(i);
  }

  return result;
}

main();
