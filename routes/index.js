/**
 * 路由汇总
 */
const express = require('express');
const router = express.Router();

const authRoutes = require('./auth');
const adminRoutes = require('./admin');
const feedbackRoutes = require('./feedback');
const tasksRoutes = require('./tasks');
const previewRoutes = require('./preview');
const filesRoutes = require('./files');
const usersRoutes = require('./users');

// 挂载路由
router.use('/', authRoutes);
router.use('/admin', adminRoutes);
router.use('/feedback', feedbackRoutes);
router.use('/tasks', tasksRoutes);
router.use('/preview', previewRoutes);
router.use('/', filesRoutes);
router.use('/users', usersRoutes);

module.exports = router;
