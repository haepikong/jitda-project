const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = __dirname;
const reflections = [];
const lessonReflections = [];
const courses = ['과학', '국어', '수학'];
const classrooms = [{ id: randomUUID(), name: '1학년 2반', code: '1학년 2반', courses: ['과학', '국어', '수학'] }];
const eventClients = new Set();
const lessonEventClients = new Map();
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 200_000) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function publishReflections() {
  const event = `data: ${JSON.stringify({ reflections, classrooms, courses })}\n\n`;
  for (const client of eventClients) {
    if (client.destroyed) eventClients.delete(client);
    else client.write(event);
  }
}

function publishLessonReflections(teacherName) {
  const event = `data: ${JSON.stringify(lessonReflections.filter(item => item.teacherName === teacherName))}\n\n`;
  for (const [client, name] of lessonEventClients) {
    if (client.destroyed) lessonEventClients.delete(client);
    else if (name === teacherName) client.write(event);
  }
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && requestUrl.pathname === '/api/reflections') {
    return sendJson(response, 200, reflections);
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/classrooms') {
    return sendJson(response, 200, classrooms);
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/classrooms/lookup') {
    const code = String(requestUrl.searchParams.get('code') || '').trim().toLocaleLowerCase();
    const classroom = classrooms.find(item => item.code.trim().toLocaleLowerCase() === code);
    if (!classroom) return sendJson(response, 404, { error: 'Class code not found' });
    return sendJson(response, 200, classroom);
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/courses') {
    return sendJson(response, 200, courses);
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/lesson-reflections') {
    const teacherName = String(requestUrl.searchParams.get('teacher') || '').trim().slice(0, 80);
    return sendJson(response, 200, lessonReflections.filter(item => item.teacherName === teacherName));
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/lesson-reflection-events') {
    const teacherName = String(requestUrl.searchParams.get('teacher') || '').trim().slice(0, 80);
    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8'
    });
    response.write(`data: ${JSON.stringify(lessonReflections.filter(item => item.teacherName === teacherName))}\n\n`);
    lessonEventClients.set(response, teacherName);
    response.on('close', () => lessonEventClients.delete(response));
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/reflection-events') {
    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8'
    });
    response.write(`data: ${JSON.stringify({ reflections, classrooms, courses })}\n\n`);
    eventClients.add(response);
    response.on('close', () => eventClients.delete(response));
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/courses') {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, error.status || 400, { error: error.message });
      return;
    }
    const course = String(body.course || '').trim().slice(0, 80);
    if (!course) return sendJson(response, 400, { error: 'Course name is required' });
    if (courses.some(item => item.toLocaleLowerCase() === course.toLocaleLowerCase())) {
      return sendJson(response, 409, { error: 'Course already exists' });
    }
    courses.push(course);
    publishReflections();
    return sendJson(response, 201, { course, courses });
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/classrooms') {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, error.status || 400, { error: error.message });
      return;
    }
    const code = String(body.code || '').trim().slice(0, 60);
    const name = String(body.name || code).trim().slice(0, 80);
    if (!code || !name) return sendJson(response, 400, { error: 'Class name and code are required' });
    if (classrooms.some(item => item.code.toLocaleLowerCase() === code.toLocaleLowerCase())) {
      return sendJson(response, 409, { error: 'Class code already exists' });
    }
    const selectedCourses = Array.isArray(body.courses)
      ? [...new Set(body.courses.map(course => String(course).trim()).filter(course => courses.includes(course)))]
      : [];
    if (!selectedCourses.length) return sendJson(response, 400, { error: 'Select at least one registered course' });
    const classroom = { id: randomUUID(), name, code, courses: selectedCourses };
    classrooms.push(classroom);
    publishReflections();
    return sendJson(response, 201, classroom);
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/classrooms/generate') {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, error.status || 400, { error: error.message });
      return;
    }
    const grade = Number(body.grade);
    const count = Number(body.count);
    const start = Number(body.start) || 1;
    const selectedCourses = Array.isArray(body.courses)
      ? [...new Set(body.courses.map(course => String(course).trim()).filter(course => courses.includes(course)))]
      : [];
    if (!Number.isInteger(grade) || grade < 1 || grade > 12 || !Number.isInteger(start) || start < 1 || start > 99 || !Number.isInteger(count) || count < 1 || count > 40 || start + count - 1 > 99) {
      return sendJson(response, 400, { error: 'Grade and class count are out of range' });
    }
    if (!selectedCourses.length) return sendJson(response, 400, { error: 'Select at least one registered course' });
    const created = [];
    for (let section = start; section < start + count; section++) {
      const code = `G${grade}-C${String(section).padStart(2, '0')}`;
      if (classrooms.some(item => item.code === code)) continue;
      const classroom = { id: randomUUID(), name: `${grade}학년 ${section}반`, code, courses: selectedCourses };
      classrooms.push(classroom);
      created.push(classroom);
    }
    if (!created.length) return sendJson(response, 409, { error: 'These class codes already exist' });
    publishReflections();
    return sendJson(response, 201, { created, skipped: count - created.length });
  }

  const removeCourseMatch = requestUrl.pathname.match(/^\/api\/classrooms\/([^/]+)\/courses\/([^/]+)$/);
  if (request.method === 'DELETE' && removeCourseMatch) {
    let classroomId;
    let course;
    try {
      classroomId = decodeURIComponent(removeCourseMatch[1]);
      course = decodeURIComponent(removeCourseMatch[2]);
    } catch {
      return sendJson(response, 400, { error: 'Invalid classroom or course' });
    }
    const classroom = classrooms.find(item => item.id === classroomId);
    if (!classroom) return sendJson(response, 404, { error: 'Classroom not found' });
    if (!classroom.courses.includes(course)) return sendJson(response, 404, { error: 'Course not found in classroom' });
    classroom.courses = classroom.courses.filter(item => item !== course);
    publishReflections();
    return sendJson(response, 200, classroom);
  }

  const classroomCoursesMatch = requestUrl.pathname.match(/^\/api\/classrooms\/([^/]+)\/courses$/);
  if (request.method === 'DELETE' && classroomCoursesMatch) {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, error.status || 400, { error: error.message });
      return;
    }
    let classroomId;
    try {
      classroomId = decodeURIComponent(classroomCoursesMatch[1]);
    } catch {
      return sendJson(response, 400, { error: 'Invalid classroom id' });
    }
    const classroom = classrooms.find(item => item.id === classroomId);
    if (!classroom) return sendJson(response, 404, { error: 'Classroom not found' });
    const requested = Array.isArray(body.courses) ? body.courses.map(course => String(course).trim()) : [];
    const removed = [...new Set(requested)].filter(course => classroom.courses.includes(course));
    if (!removed.length) return sendJson(response, 400, { error: 'Select courses in this classroom to remove' });
    classroom.courses = classroom.courses.filter(course => !removed.includes(course));
    publishReflections();
    return sendJson(response, 200, { classroom, removed });
  }

  const courseMatch = requestUrl.pathname.match(/^\/api\/classrooms\/([^/]+)\/courses$/);
  if (request.method === 'POST' && courseMatch) {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, error.status || 400, { error: error.message });
      return;
    }
    let classroomId;
    try {
      classroomId = decodeURIComponent(courseMatch[1]);
    } catch {
      return sendJson(response, 400, { error: 'Invalid classroom id' });
    }
    const classroom = classrooms.find(item => item.id === classroomId);
    if (!classroom) return sendJson(response, 404, { error: 'Classroom not found' });
    const requestedCourses = Array.isArray(body.courses)
      ? body.courses.map(course => String(course).trim().slice(0, 80))
      : [String(body.course || '').trim().slice(0, 80)];
    if (!requestedCourses.some(Boolean)) return sendJson(response, 400, { error: 'At least one course is required' });
    const selectedCourses = [...new Set(requestedCourses.filter(course => courses.includes(course) && !classroom.courses.includes(course)))];
    if (!selectedCourses.length) return sendJson(response, 409, { error: 'No new shared courses were selected' });
    classroom.courses.push(...selectedCourses);
    publishReflections();
    return sendJson(response, 201, { classroom, added: selectedCourses });
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/reflections') {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, error.status || 400, { error: error.message });
      return;
    }
    const reflection = {
      id: randomUUID(),
      classCode: String(body.classCode || '').trim().slice(0, 60),
      course: String(body.course || '').trim().slice(0, 80),
      number: String(body.number || '').trim().slice(0, 20),
      name: String(body.name || '').trim().slice(0, 80),
      mood: String(body.mood || '').trim().slice(0, 40),
      learned: String(body.learned || '').trim().slice(0, 4000),
      difficulty: String(body.difficulty || '').trim().slice(0, 2000),
      nextStep: String(body.nextStep || '').trim().slice(0, 2000),
      unit: String(body.unit || '').trim().slice(0, 100),
      reply: '',
      createdAt: Date.now()
    };
    if (!reflection.classCode || !reflection.course || !reflection.number || !reflection.name || !reflection.learned) {
      return sendJson(response, 400, { error: 'Student details and a reflection are required' });
    }
    const classroom = classrooms.find(item => item.code === reflection.classCode);
    if (!classroom || !classroom.courses.includes(reflection.course)) {
      return sendJson(response, 400, { error: 'Choose a registered classroom and course' });
    }
    reflections.push(reflection);
    publishReflections();
    return sendJson(response, 201, { ok: true, id: reflection.id });
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/lesson-reflections') {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, error.status || 400, { error: error.message });
      return;
    }
    const reflection = {
      id: randomUUID(),
      teacherName: String(body.teacherName || '').trim().slice(0, 80),
      classCode: String(body.classCode || '').trim().slice(0, 60),
      className: String(body.className || '').trim().slice(0, 80),
      course: String(body.course || '').trim().slice(0, 80),
      title: String(body.title || '').trim().slice(0, 120),
      transcript: String(body.transcript || '').trim().slice(0, 15000),
      strengths: String(body.strengths || '').trim().slice(0, 4000),
      growth: String(body.growth || '').trim().slice(0, 4000),
      nextStep: String(body.nextStep || '').trim().slice(0, 4000),
      reflection: String(body.reflection || '').trim().slice(0, 6000),
      createdAt: Date.now()
    };
    if (!reflection.teacherName || !reflection.classCode || !reflection.course || !reflection.title || !reflection.transcript || !reflection.reflection) {
      return sendJson(response, 400, { error: 'Teacher, class, course, title, transcript, and reflection are required' });
    }
    const classroom = classrooms.find(item => item.code === reflection.classCode);
    if (!classroom || !classroom.courses.includes(reflection.course)) {
      return sendJson(response, 400, { error: 'Choose a registered classroom and course' });
    }
    lessonReflections.push(reflection);
    publishLessonReflections(reflection.teacherName);
    return sendJson(response, 201, { ok: true, id: reflection.id });
  }

  const stickerMatch = requestUrl.pathname.match(/^\/api\/reflections\/([^/]+)\/sticker$/);
  if (request.method === 'POST' && stickerMatch) {
    let id;
    try {
      id = decodeURIComponent(stickerMatch[1]);
    } catch {
      return sendJson(response, 400, { error: 'Invalid reflection id' });
    }
    const reflection = reflections.find(item => item.id === id);
    if (!reflection) return sendJson(response, 404, { error: 'Reflection not found' });
    if (reflection.stickerAt) return sendJson(response, 409, { error: 'A sticker was already awarded' });
    reflection.stickerAt = Date.now();
    publishReflections();
    return sendJson(response, 200, { ok: true });
  }

  const replyMatch = requestUrl.pathname.match(/^\/api\/reflections\/([^/]+)\/reply$/);
  if (request.method === 'POST' && replyMatch) {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, error.status || 400, { error: error.message });
      return;
    }
    let id;
    try {
      id = decodeURIComponent(replyMatch[1]);
    } catch {
      return sendJson(response, 400, { error: 'Invalid reflection id' });
    }
    const reflection = reflections.find(item => item.id === id);
    const reply = String(body.reply || '').trim().slice(0, 2000);
    if (!reflection) return sendJson(response, 404, { error: 'Reflection not found' });
    if (!reply) return sendJson(response, 400, { error: 'A reply is required' });
    reflection.reply = reply;
    reflection.repliedAt = Date.now();
    publishReflections();
    return sendJson(response, 200, { ok: true });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return sendJson(response, 405, { error: 'Method not allowed' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    return sendJson(response, 400, { error: 'Invalid path' });
  }
  const filePath = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    return sendJson(response, 403, { error: 'Forbidden' });
  }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return response.end('Not found');
    }
    response.writeHead(200, {
      'Content-Length': stats.size,
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    });
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(filePath).pipe(response);
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Baeumgil reflection journal listening on ${port}`);
});
