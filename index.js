// =========================================================================
// 🌐 MAIN ROUTER WORKER (Wrangler ES Module Format)
// =========================================================================

// আপনার ১৪টি ওয়ার্কার নোডের ডোমেইন বা সাবডোমেইনের লিস্ট
const WORKER_NODES = [
  "https://node1.yourdomain.workers.dev",
  "https://node2.yourdomain.workers.dev",
  "https://node3.yourdomain.workers.dev",
  "https://node4.yourdomain.workers.dev",
  "https://node5.yourdomain.workers.dev",
  "https://node6.yourdomain.workers.dev",
  "https://node7.yourdomain.workers.dev",
  "https://node8.yourdomain.workers.dev",
  "https://node9.yourdomain.workers.dev",
  "https://node10.yourdomain.workers.dev",
  "https://node11.yourdomain.workers.dev",
  "https://node12.yourdomain.workers.dev",
  "https://node13.yourdomain.workers.dev",
  "https://node14.yourdomain.workers.dev"
];

export default {
  async fetch(request, env, ctx) {
    // 1. CORS Preflight Handling
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.toLowerCase();

    // 2. Extension Filter Check
    const isManifest = pathname.endsWith('.m3u8') || pathname.endsWith('.mpd');
    const isSegment = pathname.endsWith('.ts') || pathname.endsWith('.m4a') || pathname.endsWith('.m4s') || pathname.endsWith('.aac');

    if (!isManifest && !isSegment) {
      return new Response("Invalid Stream Endpoint", { status: 403 });
    }

    // 🎯 3. Smart Node Selection (Cache Check & Failover)
    let selectedWorkerUrl = null;

    for (const node of WORKER_NODES) {
      try {
        const testUrl = `${node}${url.pathname}${url.search}`;
        
        // ওয়ার্কার নোডে HEAD রিকোয়েস্ট পাঠিয়ে চেক করা ক্যাশ আছে কি না বা নোড লাইভ আছে কি না
        const checkRes = await fetch(testUrl, { 
          method: "HEAD",
          cf: { cacheTtl: 2 } 
        });

        if (checkRes.ok) {
          const cacheStatus = checkRes.headers.get("CF-Cache-Status");
          // যদি কোনো নোডে ক্যাশ হিট থাকে, তবে সঙ্গে সঙ্গে সেট করে লুপ ব্রেক করা হবে
          if (cacheStatus === "HIT") {
            selectedWorkerUrl = testUrl;
            break; 
          } else if (!selectedWorkerUrl) {
            // ক্যাশ না থাকলেও নোড অ্যাক্টিভ থাকলে ফলব্যাক হিসেবে রাখা
            selectedWorkerUrl = testUrl;
          }
        }
      } catch (e) {
        // নোড ডাউন থাকলে স্কিপ করবে
        continue;
      }
    }

    // কোনো নোড রেসপন্স না করলে ফলব্যাক
    if (!selectedWorkerUrl) {
      selectedWorkerUrl = `${WORKER_NODES[0]}${url.pathname}${url.search}`;
    }

    // 🚀 4. Redirect User to Target Node
    return Response.redirect(selectedWorkerUrl, 307);
  }
};