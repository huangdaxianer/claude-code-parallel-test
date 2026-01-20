# 二次函数曲线展示项目

## 项目概述

本项目实现了一个二次函数 y = ax² + bx + c 曲线的交互式展示页面，完全符合用户要求：

1. **页面主要部分是红色的 y=ax²+bx+c 曲线**
2. **坐标原点在中间**
3. **x轴和y轴线条颜色为黑色，粗细为1磅**
4. **刻度值自适应**
5. **红色曲线的粗细为1.5磅**

## 技术实现

### 核心技术栈

- HTML5 Canvas - 图形绘制
- JavaScript - 动态计算和交互
- CSS - 页面样式

### 主要文件

- `index.html` - 主页面，默认展示 y = x² 曲线
- `quadratic.html` - 带控制面板的版本，可调整参数a、b、c
- `quadratic-curve.html` - 交互式版本，实时更新曲线
- `final.html` - 简洁版本，仅展示曲线

## 功能说明

### 基础功能

1. **居中坐标系统**
   - 原点位于画布中心 (500, 300)
   - x轴范围：-20 到 20
   - y轴范围：自适应

2. **坐标轴**
   - 颜色：黑色 (#000000)
   - 粗细：1磅
   - 箭头指示正方向
   - 刻度自适应显示

3. **曲线**
   - 颜色：红色 (#ff0000)
   - 粗细：1.5磅
   - 平滑绘制

### 交互功能

1. **参数调整** (仅在交互式版本)
   - a: 二次项系数，影响曲线开口方向和大小
   - b: 一次项系数，影响曲线平移
   - c: 常数项，影响曲线上下位置

2. **实时更新**
   - 调整参数后曲线实时更新
   - 坐标轴刻度自动调整

## 技术细节

### 坐标转换

```javascript
function transformX(x) {
    const centerX = canvas.width / 2;
    const scaleX = (canvas.width - 100) / 40; // 2*20
    return centerX + x * scaleX;
}

function transformY(y, yRange) {
    const centerY = canvas.height / 2;
    const scaleY = (canvas.height - 100) / (yRange.maxY - yRange.minY);
    return centerY - (y - yRange.minY) * scaleY + 50;
}
```

### 曲线绘制

```javascript
function drawCurve() {
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    for (let x = -20; x <= 20; x += 0.1) {
        const y = a * x * x + b * x + c;
        const screenX = transformX(x);
        const screenY = transformY(y, yRange);

        if (x === -20) {
            ctx.moveTo(screenX, screenY);
        } else {
            ctx.lineTo(screenX, screenY);
        }
    }
    ctx.stroke();
}
```

### 自适应刻度

```javascript
function calculateYRange() {
    const points = [];
    for (let x = -20; x <= 20; x += 0.1) {
        points.push(a * x * x + b * x + c);
    }
    const minY = Math.min(...points);
    const maxY = Math.max(...points);
    return { minY: minY, maxY: maxY };
}
```

## 使用方法

### 访问方式

1. 直接打开 `index.html` 文件
2. 或者启动本地服务器：`python -m http.server 8000`
3. 访问 `http://localhost:8000`

### 参数调整

在 `quadratic.html` 和 `quadratic-curve.html` 中，可以通过输入框调整参数：

- a: 调整曲线的开口大小和方向
- b: 调整曲线左右平移
- c: 调整曲线上下平移

## 项目结构

```
.
├── index.html          # 主页面
├── quadratic.html      # 带控制面板的版本
├── quadratic-curve.html # 交互式版本
├── final.html          # 简洁版本
├── parabola.html       # 基础版本
└── README.md          # 项目说明
```

## 浏览器支持

- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

## 开发者

大西瓜