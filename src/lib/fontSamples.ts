/**
 * 字体库的样张文字。
 *
 * 推荐里的字体没装之前，样张用的是随应用打包的「子集」—— 只留这个文件里出现过的字
 * （scripts/make-font-previews.py 会读这个文件取字）。**改了这里的字就要重跑一次那个脚本**，
 * 不然新加的字在没装的字体上会回落成系统字体。
 *
 * 四个场景对的是这个页面的三种用途：游戏对话框 / 视频字幕 / 视频封面 / 海报。
 * 每个场景都备了一份西文，只有西文的字体（红白机、轨道体这些）用它，不然满屏缺字框。
 */

export const SAMPLE = {
  zh: '春风又绿江南岸，明月何时照我还',
  latin: 'The quick brown fox jumps over the lazy dog',
  kana: 'いろはにほへと ちりぬるを わかよたれそ',
}

export const SCENES = {
  game: {
    speaker: '旅人',
    line: '前面就是迷雾森林了。天黑之前，我们得找到落脚的地方。',
    menu: ['开始游戏', '继续', '设置'],
    hp: 'HP 1280/3200',
    lv: 'LV.27',
    latinSpeaker: 'TRAVELER',
    latinLine: 'The forest is just ahead. We need shelter before nightfall.',
    latinMenu: ['START', 'CONTINUE', 'OPTIONS'],
  },
  subtitle: {
    zh: '今天带大家去看看，这个小镇最有名的一家面馆',
    latin: 'Today we visit the most famous noodle shop in town',
  },
  cover: {
    title: '三天做完一个游戏',
    tag: '独立开发日记 EP.07',
    latinTitle: '3 DAYS, 1 GAME',
    latinTag: 'DEVLOG EP.07',
  },
  poster: {
    title: '山海之间',
    sub: 'A JOURNEY BETWEEN MOUNTAINS AND SEA',
    date: '2026.10.01 — 10.07',
    latinTitle: 'MOUNTAINS & SEA',
  },
}
