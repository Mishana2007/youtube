// Загружаем переменные среды из .env файла
require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();

// Используем токены из переменных среды
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.GOOGLE_API_KEY;

// Инициализация базы данных
const db = new sqlite3.Database('./users.db');

// Создаем таблицу для хранения данных пользователей
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id INTEGER PRIMARY KEY,
    links TEXT,
    link_count INTEGER DEFAULT 0
  )
`);

// Функция для добавления ссылки в базу данных
function saveLinkToDatabase(chatId, link) {
  db.get('SELECT * FROM users WHERE chat_id = ?', [chatId], (err, row) => {
    if (err) {
      console.error('Ошибка при получении пользователя:', err);
      return;
    }

    if (row) {
      // Обновляем данные пользователя, если он уже существует
      const updatedLinks = row.links ? `${row.links},${link}` : link;
      const updatedCount = row.link_count + 1;
      db.run('UPDATE users SET links = ?, link_count = ? WHERE chat_id = ?', [updatedLinks, updatedCount, chatId]);
    } else {
      // Если пользователь новый, создаем новую запись
      db.run('INSERT INTO users (chat_id, links, link_count) VALUES (?, ?, ?)', [chatId, link, 1]);
    }
  });
}

// Функция для получения статистики пользователя
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

// Функция для получения videoId из ссылки YouTube (включая YouTube Shorts)
function getVideoIdFromUrl(url) {
  const urlObj = new URL(url);

  if (urlObj.hostname === 'youtu.be') {
    return urlObj.pathname.slice(1); // Убираем начальный слэш
  }

  if (urlObj.pathname.includes('/shorts/')) {
    return urlObj.pathname.split('/shorts/')[1]; // Получаем ID из YouTube Shorts
  }

  const videoId = urlObj.searchParams.get('v');
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }
  return videoId;
}

// Функция для получения комментариев по videoId
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

// Функция для удаления ссылок и текста перед и после тегов <br>
function removeUrlsAndBrText(text) {
  let cleanedText = text.replace(/https?:\/\/[^\s]+/g, ''); // Удаляем ссылки
  cleanedText = cleanedText.replace(/(<br>[^<]*|[^<]*<br>)/gi, ''); // Удаляем текст до и после <br>
  return cleanedText;
}

// Функция для фильтрации нежелательных комментариев
function filterComments(comment) {
  const keywords = [
    'subscribe', 'views', 'SEO', 'tags', 'audience', 'increase', 'followers', 'promote'
  ];
  return !keywords.some(keyword => comment.toLowerCase().includes(keyword));
}

// Функция для записи комментариев в текстовый файл
function saveCommentsToTextFile(comments, filename) {
  const filePath = path.join(__dirname, filename);
  fs.writeFileSync(filePath, comments.join('\n'));
  return filePath;
}

// Основная функция для получения и записи комментариев
async function getYouTubeComments(youtubeUrl) {
  try {
    const videoId = getVideoIdFromUrl(youtubeUrl);
    let comments = [];
    let pageToken = '';
    let batchCount = 0;

    do {
      const data = await fetchComments(videoId, pageToken);
      const fetchedComments = data.items
        .map(item => removeUrlsAndBrText(item.snippet.topLevelComment.snippet.textDisplay)) // Применяем функцию для очистки текста
        .filter(filterComments); // Применяем фильтрацию нежелательных комментариев
      comments = comments.concat(fetchedComments);

      // После каждого 1000 комментариев сохраняем промежуточные результаты в файл
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

// Создаем экземпляр бота
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Состояния для пользователей
const userStates = {};

// Обрабатываем команду /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = 'waiting_for_url';

  bot.sendMessage(chatId, 'Привет! Пожалуйста, отправьте ссылку на видео с YouTube или YouTube Shorts, чтобы я мог скопировать отзывы.');
});

// Обрабатываем команду /stats для отображения статистики пользователя
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const stats = await getUserStats(chatId);
  bot.sendMessage(chatId, stats);
});

// Обрабатываем получение сообщений
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

      // Сохраняем оставшиеся комментарии в файл и отправляем его пользователю
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
