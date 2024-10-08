require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.GOOGLE_API_KEY;

const db = new sqlite3.Database('./users.db');

// Создаем таблицу для хранения данных пользователей
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id INTEGER PRIMARY KEY,
    links TEXT,
    link_count INTEGER DEFAULT 0
  )
`);

function saveLinkToDatabase(chatId, link) {
  db.get('SELECT * FROM users WHERE chat_id = ?', [chatId], (err, row) => {
    if (err) {
      console.error('Ошибка при получении пользователя:', err);
      return;
    }

    if (row) {
      const updatedLinks = row.links ? `${row.links},${link}` : link;
      const updatedCount = row.link_count + 1;
      db.run('UPDATE users SET links = ?, link_count = ? WHERE chat_id = ?', [updatedLinks, updatedCount, chatId]);
    } else {
      db.run('INSERT INTO users (chat_id, links, link_count) VALUES (?, ?, ?)', [chatId, link, 1]);
    }
  });
}

function getUserStats(chatId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE chat_id = ?', [chatId], (err, row) => {
      if (err) {
        console.error('Ошибка при получении статистики пользователя:', err);
        return reject('Ошибка при получении статистики.');
      }
      if (row) {
        resolve(`Вы отправили ${row.link_count} ссылок. Вот ваши ссылки: ${row.links}`);
      } else {
        resolve('Вы еще не отправили ни одной ссылки.');
      }
    });
  });
}

function getVideoIdFromUrl(url) {
  const urlObj = new URL(url);

  if (urlObj.hostname === 'youtu.be') {
    return urlObj.pathname.slice(1);
  }

  if (urlObj.pathname.includes('/shorts/')) {
    return urlObj.pathname.split('/shorts/')[1];
  }

  const videoId = urlObj.searchParams.get('v');
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }
  return videoId;
}

async function fetchComments(videoId, pageToken = '') {
  const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&key=${API_KEY}&maxResults=100&pageToken=${pageToken}`;
  
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error('Error fetching comments:', error.message);
    throw new Error('Failed to fetch comments');
  }
}

function removeUrlsAndBrText(text) {
  let cleanedText = text.replace(/https?:\/\/[^\s]+/g, ''); 
  cleanedText = cleanedText.replace(/(<br>[^<]*|[^<]*<br>)/gi, '');
  return cleanedText;
}

function filterComments(comment) {
  const keywords = ['subscribe', 'views', 'SEO', 'tags', 'audience', 'increase', 'followers', 'promote'];
  return !keywords.some(keyword => comment.toLowerCase().includes(keyword));
}

function saveCommentsToTextFile(comments, filename) {
  const folderPath = path.join(__dirname, 'comments'); 
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath);
  }

  const filePath = path.join(folderPath, filename);
  fs.writeFileSync(filePath, comments.join('\n'));

  const files = fs.readdirSync(folderPath);
  if (files.length > 5) {
    files.forEach(file => fs.unlinkSync(path.join(folderPath, file)));
  }

  return filePath;
}

async function getYouTubeComments(youtubeUrl) {
  try {
    const videoId = getVideoIdFromUrl(youtubeUrl);
    let comments = [];
    let pageToken = '';
    let batchCount = 0;

    do {
      const data = await fetchComments(videoId, pageToken);
      const fetchedComments = data.items
        .map(item => removeUrlsAndBrText(item.snippet.topLevelComment.snippet.textDisplay))
        .filter(filterComments);
      comments = comments.concat(fetchedComments);

      if (comments.length >= 1000) {
        batchCount += 1;
        const batchFilename = `comments_batch_${batchCount}.txt`;
        saveCommentsToTextFile(comments.splice(0, 1000), batchFilename);
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return comments;
  } catch (error) {
    console.error('Error occurred while fetching comments:', error.message);
    throw new Error('Error fetching comments.');
  }
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = {};

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = 'waiting_for_url';
  bot.sendMessage(chatId, 'Привет! Пожалуйста, отправьте ссылку на видео с YouTube или YouTube Shorts.');
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const stats = await getUserStats(chatId);
  bot.sendMessage(chatId, stats);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (userStates[chatId] === 'waiting_for_url' && msg.text && msg.text.startsWith('http')) {
    const youtubeUrl = msg.text;

    try {
      await bot.sendMessage(chatId, 'Копирую отзывы, пожалуйста подождите...');
      
      let messageId;
      let dots = '';
      const animationInterval = setInterval(async () => {
        dots = dots.length < 3 ? dots + '.' : '';
        if (messageId) {
          await bot.editMessageText(`Копирую отзывы${dots}`, { chat_id: chatId, message_id: messageId });
        } else {
          const sentMessage = await bot.sendMessage(chatId, `Копирую отзывы${dots}`);
          messageId = sentMessage.message_id;
        }
      }, 500);

      const comments = await getYouTubeComments(youtubeUrl);
      clearInterval(animationInterval);
      await bot.editMessageText('Завершено. Отправляю файлы...', { chat_id: chatId, message_id: messageId });

      const finalFilename = saveCommentsToTextFile(comments, 'comments_final.txt');
      await bot.sendDocument(chatId, finalFilename);

      saveLinkToDatabase(chatId, youtubeUrl);
      userStates[chatId] = 'waiting_for_url';
    } catch (error) {
      await bot.sendMessage(chatId, 'Произошла ошибка при копировании отзывов. Попробуйте снова.');
      console.error(error);
    }
  } else if (userStates[chatId] === 'waiting_for_url') {
    bot.sendMessage(chatId, 'Пожалуйста, отправьте правильную ссылку на YouTube или YouTube Shorts.');
  }
});
