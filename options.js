const $ = (id) => document.getElementById(id);
const say = (t) => { $("msg").textContent = t; };

chrome.storage.local.get(["apiKey", "resume"], ({ apiKey = "", resume = "" }) => {
  $("apiKey").value = apiKey;
  $("resume").value = resume;
});

$("file").onchange = async (e) => {
  const f = e.target.files[0];
  if (f) $("resume").value = await f.text();
};

$("save").onclick = () =>
  chrome.storage.local.set({ apiKey: $("apiKey").value.trim(), resume: $("resume").value.trim() }, () => say("Saved"));
$("clear").onclick = () => chrome.storage.local.remove("scores", () => say("Cache cleared"));
