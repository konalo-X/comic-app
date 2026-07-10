import 'package:flutter/material.dart';

/// 全局设计规范（按照UI规范）
class AppColors {
  // 品牌主色：渐变蓝紫
  static const Color primaryBlue = Color(0xFF4A90E2);  // CD图标蓝
  static const Color primaryPurple = Color(0xFF6C63FF);  // 功能按钮紫蓝
  
  // 渐变
  static const Gradient primaryGradient = LinearGradient(
    colors: [primaryBlue, primaryPurple],
    begin: Alignment.centerLeft,
    end: Alignment.centerRight,
  );
  
  // 辅助状态色
  static const Color success = Color(0xFF4ECDC4);  // 浅青
  static const Color failure = Color(0xFFFF6B6B);  // 橙红
  static const Color inProgress = Color(0xFF6C63FF);  // 蓝紫
  static const Color pending = Color(0xFFB0BEC5);  // 浅灰
  
  // 文字
  static const Color textPrimary = Color(0xFF2C3E50);  // 深灰主文本
  static const Color textSecondary = Color(0xFF95A5A6);  // 浅灰辅助
  
  // 背景
  static const Color bgWhite = Color(0xFFFAFBFD);  // 极淡白底
  static const Color bgLightBlue = Color(0xFFF0F4FF);  // 极淡浅蓝渐变底
  static const Color bgCard = Colors.white;  // 纯白卡片
  
  // 分割/底纹
  static const Color divider = Color(0xFFF0F0F0);  // 极淡分割线
  
  // 导航栏
  static const Color navSelectedBg = Color(0xFFF3F0FF);  // 浅紫底色（选中）
  static const Color navSelectedBorder = primaryBlue;  // 蓝色左侧竖线
  static const Color navBadge = Color(0xFFFF4444);  // 红色角标
}

/// 全局样式工具
class AppStyles {
  // 卡片统一样式
  static BoxDecoration cardDecoration({
    bool isSelected = false,
    Color? borderColor,
  }) {
    return BoxDecoration(
      color: AppColors.bgCard,
      borderRadius: BorderRadius.circular(8),
      boxShadow: [
        BoxShadow(
          color: Colors.black.withOpacity(0.05),
          blurRadius: 8,
          offset: const Offset(0, 2),
        ),
      ],
      border: borderColor != null
          ? Border.all(color: borderColor, width: 1)
          : null,
    );
  }
  
  // 状态标签样式
  static Widget buildStatusBadge(String text, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 11,
          color: color,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
  
  // 主操作按钮（渐变蓝紫）
  static ButtonStyle primaryButtonStyle = ElevatedButton.styleFrom(
    backgroundColor: AppColors.primaryPurple,
    foregroundColor: Colors.white,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(8),
    ),
    elevation: 0,
    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
  );
  
  // 次要操作按钮（白底灰边框）
  static ButtonStyle secondaryButtonStyle = ElevatedButton.styleFrom(
    backgroundColor: Colors.white,
    foregroundColor: AppColors.textPrimary,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(8),
      side: BorderSide(color: AppColors.textSecondary.withOpacity(0.3)),
    ),
    elevation: 0,
    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
  );
  
  // 紧急重试按钮（纯蓝色填充）
  static ButtonStyle emergencyButtonStyle = ElevatedButton.styleFrom(
    backgroundColor: AppColors.primaryBlue,
    foregroundColor: Colors.white,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(8),
    ),
    elevation: 0,
    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
  );
  
  // 进度条样式（蓝紫渐变）
  static Widget buildProgressBar(double progress, {Color? color}) {
    return Container(
      height: 6,
      decoration: BoxDecoration(
        color: AppColors.pending.withOpacity(0.2),
        borderRadius: BorderRadius.circular(3),
      ),
      child: FractionallySizedBox(
        alignment: Alignment.centerLeft,
        widthFactor: progress.clamp(0.0, 1.0),
        child: Container(
          decoration: BoxDecoration(
            gradient: color != null ? null : AppColors.primaryGradient,
            color: color,
            borderRadius: BorderRadius.circular(3),
          ),
        ),
      ),
    );
  }
}
