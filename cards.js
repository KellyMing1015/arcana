// 78 张塔罗牌的名称和解读元数据；牌面图片保存在 assets/cards/。
const rawCards = [
  ["fool", "0", "THE FOOL", "愚者", "新的可能", "#b8dc65", "你可能已经站在一个新的起点。先不用保证每一步都正确，留意是什么让你想向前。"],
  ["magician", "I", "THE MAGICIAN", "魔术师", "主动创造", "#ee6875", "你手里已经有一些资源。眼下更重要的，也许是决定如何使用它们。"],
  ["priestess", "II", "THE HIGH PRIESTESS", "女祭司", "内在直觉", "#b391d7", "有些答案还没有浮出水面。允许自己再观察一会儿，也是在认真对待问题。"],
  ["empress", "III", "THE EMPRESS", "皇后", "滋养生长", "#cb87aa", "你正在照顾什么？也可以问问自己，这份照顾有没有留一点给自己。"],
  ["emperor", "IV", "THE EMPEROR", "皇帝", "边界与秩序", "#7c99cd", "清楚的边界会让关系或计划更稳。你可以温和，同时把自己的立场说清楚。"],
  ["hierophant", "V", "THE HIEROPHANT", "教皇", "信念与规则", "#ac88d9", "你所遵循的规则来自哪里？它现在还适合你吗？"],
  ["lovers", "VI", "THE LOVERS", "恋人", "真实选择", "#e596a0", "这张牌也关乎选择。靠近谁或什么之前，先确认那是否符合你真正看重的东西。"],
  ["chariot", "VII", "THE CHARIOT", "战车", "决定方向", "#659bd2", "力量并不总是冲得更快。有时是承认自己想去哪里，然后稳稳地掌舵。"],
  ["strength", "VIII", "STRENGTH", "力量", "柔软的勇气", "#e7a36f", "你不需要压住全部感受。能看见它们、仍然选择怎样行动，也是一种力量。"],
  ["hermit", "IX", "THE HERMIT", "隐者", "安静地寻找", "#8fa9bd", "外界的声音也许太多。给自己一点安静，辨认哪些想法真正属于你。"],
  ["wheel", "X", "WHEEL OF FORTUNE", "命运之轮", "变化的周期", "#6ac5c3", "局面正在变化。你无法控制所有转动，但可以选择此刻要抓住什么。"],
  ["justice", "XI", "JUSTICE", "正义", "诚实面对", "#72b7b3", "温柔不等于回避事实。试着把愿望和已经发生的事分开看。"],
  ["hanged", "XII", "THE HANGED ONE", "倒吊人", "换一个角度", "#8e9de4", "暂停可能令人不安，却也给你机会，从另一个角度看见熟悉的问题。"],
  ["death", "XIII", "DEATH", "死神", "结束与更新", "#89b58c", "某个阶段或许正在结束。遗憾是真实的，新的空间也可能由此出现。"],
  ["temperance", "XIV", "TEMPERANCE", "节制", "寻找平衡", "#92c4b8", "不必在两个极端中立刻选边。也许存在一种更适合你的节奏。"],
  ["devil", "XV", "THE DEVIL", "恶魔", "看见束缚", "#b68aab", "你是不是反复回到一个让自己受伤的模式？先看清它，才有机会松开。"],
  ["tower", "XVI", "THE TOWER", "高塔", "旧结构松动", "#b4cf6d", "已经不稳的部分正在显露。它令人难受，也让你看见哪里需要重新搭建。"],
  ["star", "XVII", "THE STAR", "星星", "希望与修复", "#8cc1d4", "希望不一定是确信会有好结果。它也可以是你愿意再照顾自己一次。"],
  ["moon", "XVIII", "THE MOON", "月亮", "未知与感受", "#a99bd7", "眼前也许有些模糊。先照顾自己的不安，再慢慢分辨事实与想象。"],
  ["sun", "XIX", "THE SUN", "太阳", "清晰与喜悦", "#e1c76f", "允许自己承认已经获得的清晰和快乐，不必因为担心失去就缩小它。"],
  ["judgement", "XX", "JUDGEMENT", "审判", "重新回应", "#db9683", "过去的声音可能再次出现。这次你可以用现在的自己，给出不同的回应。"],
  ["world", "XXI", "THE WORLD", "世界", "完整的阶段", "#c49dd4", "一个阶段的意义正在成形。看看自己走过的路，也看看下一段想带走什么。"],
];

export const CARDS = rawCards.map(([id, number, english, chinese, keyword, accent, reflection]) => ({
  id, number, english, chinese, keyword, accent, reflection,
}));

const suits = [
  { id: "wands", english: "WANDS", chinese: "权杖", accent: "#cad46f", keyword: "行动与热情" },
  { id: "cups", english: "CUPS", chinese: "圣杯", accent: "#a786d8", keyword: "情感与连接" },
  { id: "swords", english: "SWORDS", chinese: "宝剑", accent: "#83b9cc", keyword: "想法与决定" },
  { id: "pentacles", english: "PENTACLES", chinese: "星币", accent: "#dc9d75", keyword: "现实与资源" },
];
const ranks = [
  ["ACE", "王牌", "A"], ["TWO", "二", "II"], ["THREE", "三", "III"],
  ["FOUR", "四", "IV"], ["FIVE", "五", "V"], ["SIX", "六", "VI"],
  ["SEVEN", "七", "VII"], ["EIGHT", "八", "VIII"], ["NINE", "九", "IX"],
  ["TEN", "十", "X"], ["PAGE", "侍从", "P"], ["KNIGHT", "骑士", "N"],
  ["QUEEN", "王后", "Q"], ["KING", "国王", "K"],
];
export const MINOR_CARDS = suits.flatMap((suit) => ranks.map(([english, chinese, number], rankIndex) => ({
  id: `${suit.id}-${rankIndex + 1}`,
  number,
  english: `${english} OF ${suit.english}`,
  chinese: `${suit.chinese}${chinese}`,
  keyword: suit.keyword,
  accent: suit.accent,
  suit: suit.id,
  rank: rankIndex + 1,
  reflection: `这张牌邀请你关注${suit.keyword}，并把它放回你正在经历的事情里看。`,
})));
export const DECK = [...CARDS, ...MINOR_CARDS];

export function cardFace(card, className = "") {
  return `<img class="card-art ${className}" src="./assets/cards/${card.id}.jpg" width="960" height="1646" alt="${card.chinese}塔罗牌" draggable="false">`;
}
