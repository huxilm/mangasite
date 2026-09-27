-- Mangasite 数据库结构
--
-- 用法（在仓库根目录）：
--   mysql -u root -p < server/schema.sql
--
-- 这份文件是照着实际在跑的库导出来的（SHOW CREATE TABLE），
-- 改了表结构之后记得同步改这里，否则别人按这份建出来的库跟你的对不上。
--
-- 注意建表顺序：chapters 指向 manga，favorites 指向 series，
-- 所以 manga / series 必须先建出来，否则外键约束会报错。

CREATE DATABASE IF NOT EXISTS `mangasite`
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE `mangasite`;

-- 漫画主表。tags 存的是给前端看的原始文本，上传弹窗写进去的是
-- JSON 数组字符串（'["热血","冒险"]'）；读取时 parseTags 连逗号串
-- （'热血,冒险'）也认，所以这里不加约束、也不拆表。
--
-- ⚠ lovecounts 是冗余的：点赞的事实来源是 likes 表，这一列只是缓存下来
-- 方便列表页按热度排序。两者在 update-like 接口里一起维护，且没有事务。
CREATE TABLE `manga` (
  `id`         int NOT NULL AUTO_INCREMENT,
  `title`      varchar(100) NOT NULL,
  `author`     varchar(100) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `tags`       varchar(100) DEFAULT NULL,
  `cover`      varchar(255) DEFAULT NULL,
  `lovecounts` int DEFAULT '0',
  `readcounts` int DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 收藏的「系列」分组。每个用户各建各的，uk_user_series 保证同一个人名下不重名。
CREATE TABLE `series` (
  `id`         int NOT NULL AUTO_INCREMENT,
  `user_id`    int NOT NULL,
  `name`       varchar(50) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_series` (`user_id`,`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `user` (
  `id`         int NOT NULL AUTO_INCREMENT,
  `username`   varchar(50) NOT NULL,
  `email`      varchar(100) NOT NULL,
  `password`   varchar(255) NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 一话。pages 是 JSON 数组，存的是一页页图片的 URL 路径。
-- ON DELETE CASCADE：删掉 manga 这一行，它名下的话会自动跟着删，
-- 所以后端删漫画时不用自己删 chapters。
CREATE TABLE `chapters` (
  `id`             int NOT NULL AUTO_INCREMENT,
  `manga_id`       int NOT NULL,
  `chapter_number` int NOT NULL,
  `title`          varchar(255) DEFAULT NULL,
  `pages`          json DEFAULT NULL,
  `created_at`     datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_chapters_manga` (`manga_id`),
  CONSTRAINT `fk_chapters_manga` FOREIGN KEY (`manga_id`)
    REFERENCES `manga` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 点赞。uk_user_manga 保证同一个人对同一本只能有一条记录，
-- 所以「点赞 / 取消点赞」是插入或删除这一行，不是改计数。
-- ⚠ 这张表没有指向 manga 的外键，删漫画时要自己删这里的行。
CREATE TABLE `likes` (
  `id`         int NOT NULL AUTO_INCREMENT,
  `user_id`    int NOT NULL,
  `manga_id`   int NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_manga` (`user_id`,`manga_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 收藏。series_id 为 NULL 表示「未分类」。
-- ON DELETE SET NULL：删掉一个系列，组里的收藏不会跟着消失，只是回到未分类。
-- ⚠ 和 likes 一样，没有指向 manga 的外键，删漫画时要自己删这里的行。
CREATE TABLE `favorites` (
  `id`         int NOT NULL AUTO_INCREMENT,
  `user_id`    int NOT NULL,
  `manga_id`   int NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `series_id`  int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_manga` (`user_id`,`manga_id`),
  KEY `fk_favorites_series` (`series_id`),
  CONSTRAINT `fk_favorites_series` FOREIGN KEY (`series_id`)
    REFERENCES `series` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
