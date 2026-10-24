// =========================================================================
// 🌐 SMART ULTRA-FAST ROUTER WITH 10S CACHE & HEALTH-CHECK FAILOVER
// =========================================================================

const WORKER_NODES = [
  "https://node1.cdn-ottking1.workers.dev",
  "https://node2.cdn-ottking1.workers.dev",
  // আপনার বাকি নোডগুলো এখানে যোগ করুন...
];

// স্ট্রিমের শেষ রাউটিং রেকর্ড রাখার জন্য ম্যাপ: 
// Key: streamKey, Value: { node: string, timestamp: number }
const streamRouteHistory = new Map();

// ডাউন বা স্লো নোড ট্র্যাক করার জন্য ম্যাপ (Cooldown: ৩০ সেকেন্ড)
const deadNodes = new Map();
const FAILURE_COOLDOWN = 30000; 

export default {
  async fetch(request, env, ctx) {
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

    const isManifest = pathname.endsWith('.m3u8') || pathname.endsWith('.mpd');
    const isSegment = pathname.endsWith('.ts') || pathname.endsWith('.m4a') || pathname.endsWith('.m4s') || pathname.endsWith('.aac');

    if (!isManifest && !isSegment) {
      return new Response("Invalid Stream Endpoint", { status: 403 });
    }

    // ১. স্ট্রিম বা চ্যানেলের ইউনিক কি তৈরি (যেমন: /live/ch1/index.m3u8 থেকে channel key বের করা)
    const pathParts = pathname.split('/');
    const streamKey = pathParts.length > 2 ? `${pathParts[1]}/${pathParts[2]}` : pathname;

    let targetNode = null;
    let now = Date.now();
    const TEN_SECONDS = 10000;

    // ২. চেক করা যাক এই স্ট্রিমের জন্য সম্প্রতি কোনো নোড অ্যাসাইন করা হয়েছিল কি না
    if (streamRouteHistory.has(streamKey)) {
      const record = streamRouteHistory.get(streamKey);
      
      // যদি শেষ ১০ সেকেন্ডের মধ্যে রিকুয়েস্ট এসে থাকে
      if ((now - record.timestamp) < TEN_SECONDS) {
        // এবং নোডটি যদি ডাউন লিস্টে না থাকে, তবে চোখ বন্ধ করে ওই পুরনো নোডেই পাঠিয়ে দেওয়া হবে (আল্ট্রা-ফাস্ট)
        if (!isNodeDead(record.node, now)) {
          targetNode = record.node;
        }
      }
    }

    // ৩. যদি ১০ সেকেন্ড পার হয়ে যায় অথবা নতুন স্ট্রিম হয়, তবে স্মার্ট চেকিং শুরু হবে
    if (!targetNode) {
      // প্রথমে হ্যাশ বা রোটেশন করে একটি সম্ভাব্য বেস্ট নোড সিলেক্ট করা
      const aliveNodes = getAliveNodes(now);
      const availableList = aliveNodes.length > 0 ? aliveNodes : WORKER_NODES;

      let hash = 0;
      for (let i = 0; i < streamKey.length; i++) {
        hash = (hash << 5) - hash + streamKey.charCodeAt(i);
        hash |= 0;
      }
      let candidateNode = availableList[Math.abs(hash) % availableList.length];

      // ৪. সিলেক্টেড নোডে HEAD রিকোয়েস্ট দিয়ে চেক করা যে ক্যাশ HIT আছে কি না বা নোড লাইভ আছে কি না
      try {
        const testUrl = `${candidateNode}${url.pathname}${url.search}`;
        const checkRes = await fetch(testUrl, {
          method: "HEAD",
          cf: { cacheTtl: 2 } // অতি দ্রুত চেকের জন্য ক্লাউডফ্লেয়ার এজ ক্যাশ হুক
        });

        if (checkRes.ok) {
          const cacheStatus = checkRes.headers.get("CF-Cache-Status");
          // যদি ক্যাশ HIT থাকে অথবা নোড রেসপন্স ঠিকঠাক দেয়, তবে একেই ফাইনাল নোড ধরে নেওয়া হবে
          if (cacheStatus === "HIT" || checkRes.status === 200) {
            targetNode = candidateNode;
          }
        }
      } catch (e) {
        // যদি নোড রেসপন্স না করে বা ডাউন থাকে, তবে একে ডেড লিস্টে ফেলে দেওয়া হবে
        markNodeAsDead(candidateNode, now);
      }

      // যদি প্রথম ক্যান্ডিডেট নোড ফেল করে, তবে অন্য কোনো সচল নোড থেকে একটি বেছে নেওয়া
      if (!targetNode) {
        for (const node of availableList) {
          if (node === candidateNode) continue;
          try {
            const testUrl = `${node}${url.pathname}${url.search}`;
            const checkRes = await fetch(testUrl, { method: "HEAD", cf: { cacheTtl: 2 } });
            if (checkRes.ok) {
              targetNode = node;
              break;
            }
          } catch (err) {
            markNodeAsDead(node, now);
          }
        }
      }

      // শেষ পর্যন্ত কোনো নোড রেসপন্স না করলে ফলব্যাক হিসেবে প্রথম নোডটিই নিয়ে নেওয়া
      if (!targetNode) {
        targetNode = WORKER_NODES[0];
      }
    }

    // ৫. বর্তমান সফল নোড এবং টাইমস্ট্যাম্প ম্যাপে আপডেট করে রাখা (রেকর্ড সংরক্ষণ)
    streamRouteHistory.set(streamKey, { node: targetNode, timestamp: now });

    // মেমরি ক্লিনআপ (ম্যাপ যেন বেশি বড় হয়ে না যায়)
    if (streamRouteHistory.size > 10000) {
      const firstKey = streamRouteHistory.keys().next().value;
      streamRouteHistory.delete(firstKey);
    }

    const targetUrl = `${targetNode}${url.pathname}${url.search}`;

    // 🚀 আল্ট্রা-ফাস্ট রিডাইরেক্ট
    return Response.redirect(targetUrl, 307);
  }
};

// --- হেল্পার ফাংশনসমূহ ---

function isNodeDead(node, now) {
  if (deadNodes.has(node)) {
    if ((now - deadNodes.get(node)) < FAILURE_COOLDOWN) {
      return true; // এখনও কুলডাউনে আছে
    } else {
      deadNodes.delete(node); // কুলডাউন শেষ, আবার লাইভ
    }
  }
  return false;
}

function markNodeAsDead(node, now) {
  deadNodes.set(node, now);
}

function getAliveNodes(now) {
  return WORKER_NODES.filter(node => !isNodeDead(node, now));
}
